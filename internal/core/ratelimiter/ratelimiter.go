// Package ratelimiter is a goroutine-safe token-bucket rate limiter used to
// throttle embedding generation and LLM API calls.
//
// It ports src/core/ratelimiter.ts. The TS limiter ran on the single-threaded
// JS event loop and used Date.now() plus a setTimeout-driven promise queue;
// this Go port is concurrency-safe (a mutex guards the token/queue state) and
// abstracts time behind an injectable clock so refill/acquire behavior is
// deterministically testable without real wall-clock sleeps.
//
// Semantics preserved from the TS implementation:
//   - The bucket starts FULL (tokens == maxTokens).
//   - maxTokens == burstSize (default 1); refillRate == requestsPerSecond/1000
//     tokens per millisecond (default RPS 0.5).
//   - refill(): elapsed = now - lastRefill (ms); if elapsed > 0, tokens =
//     min(maxTokens, tokens + elapsed*refillRate), lastRefill = now.
//   - Acquire blocks (respecting ctx) until a token is available; concurrent
//     waiters are served FIFO.
//   - TryAcquire is non-blocking.
//   - AvailableTokens returns floor(tokens) after a refill.
package ratelimiter

import (
	"context"
	"math"
	"sync"
	"time"
)

// DefaultRPS is the default requests-per-second for both embedding and LLM
// limiters, mirroring DEFAULT_EMBEDDING_RPS / DEFAULT_LLM_RPS (0.5) in the TS.
const DefaultRPS = 0.5

// DefaultBurst is the default bucket capacity when burstSize is unset.
const DefaultBurst = 1

// Config configures a RateLimiter.
type Config struct {
	// RequestsPerSecond is the token refill rate. Zero uses DefaultRPS.
	RequestsPerSecond float64
	// BurstSize is the bucket capacity. Zero uses DefaultBurst.
	BurstSize int
	// Now is the clock used for refill timing. Nil uses time.Now. Injecting a
	// fake clock makes refill/acquire deterministic in tests.
	Now func() time.Time
}

// waiter is one blocked Acquire call. It is signaled by closing ready once a
// token has been reserved for it.
type waiter struct {
	ready chan struct{}
}

// RateLimiter is a token-bucket limiter. The zero value is not usable; create
// one with New.
type RateLimiter struct {
	maxTokens  float64
	refillRate float64 // tokens per millisecond
	now        func() time.Time

	mu         sync.Mutex
	tokens     float64
	lastRefill time.Time
	queue      []*waiter
}

// New creates a RateLimiter with the bucket starting full.
func New(cfg Config) *RateLimiter {
	rps := cfg.RequestsPerSecond
	if rps == 0 {
		rps = DefaultRPS
	}
	burst := cfg.BurstSize
	if burst == 0 {
		burst = DefaultBurst
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	maxTokens := float64(burst)
	return &RateLimiter{
		maxTokens:  maxTokens,
		refillRate: rps / 1000, // tokens per millisecond, matching the TS
		now:        now,
		tokens:     maxTokens, // bucket starts full
		lastRefill: now(),
	}
}

// refill adds tokens based on elapsed time. Caller must hold mu.
func (r *RateLimiter) refill() {
	now := r.now()
	elapsed := float64(now.Sub(r.lastRefill).Milliseconds())
	if elapsed > 0 {
		r.tokens = math.Min(r.maxTokens, r.tokens+elapsed*r.refillRate)
		r.lastRefill = now
	}
}

// TryAcquire consumes one token without blocking. It returns true if a token
// was available, false otherwise.
func (r *RateLimiter) TryAcquire() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.refill()
	if r.tokens >= 1 {
		r.tokens -= 1
		return true
	}
	return false
}

// AvailableTokens returns the current whole-token count after a refill.
func (r *RateLimiter) AvailableTokens() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.refill()
	return int(math.Floor(r.tokens))
}

// Acquire blocks until a token is available or ctx is cancelled. Concurrent
// callers are served FIFO. On ctx cancellation it returns ctx.Err() without
// consuming a token.
//
// A token is consumed at one of two points: immediately, if the bucket has a
// token and no one is ahead in the queue; or later, by processQueue, which
// reserves a token for the head waiter before signaling it. This mirrors the
// TS promise-queue: a queued request only resolves once a token has been
// deducted on its behalf.
func (r *RateLimiter) Acquire(ctx context.Context) error {
	r.mu.Lock()
	r.refill()
	if len(r.queue) == 0 && r.tokens >= 1 {
		r.tokens -= 1
		r.mu.Unlock()
		return nil
	}

	w := &waiter{ready: make(chan struct{})}
	r.queue = append(r.queue, w)
	r.scheduleProcessing()
	r.mu.Unlock()

	select {
	case <-w.ready:
		// A token was reserved for us by processQueue.
		return nil
	case <-ctx.Done():
		if r.cancelWaiter(w) {
			return ctx.Err()
		}
		// We were already signaled in the race with cancellation; the token is
		// ours, so honor the successful acquire.
		return nil
	}
}

// cancelWaiter removes w from the queue if it is still pending. It returns true
// if w was removed (cancellation wins), false if w was already signaled (a
// token was reserved for it and must be treated as acquired).
func (r *RateLimiter) cancelWaiter(w *waiter) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, q := range r.queue {
		if q == w {
			r.queue = append(r.queue[:i], r.queue[i+1:]...)
			return true
		}
	}
	return false
}

// scheduleProcessing arranges for the queue to be processed once enough time
// has elapsed for the next token to refill. Caller must hold mu.
//
// It mirrors the TS scheduleQueueProcessing: waitMs = ceil((1 - tokens) /
// refillRate). Processing runs on a background goroutine after the limiter's
// clock has advanced by waitMs. Real-clock limiters use a time.Timer; fake
// clocks (where now() is driven externally) poll until enough simulated time
// has elapsed, so tests never block on wall-clock time.
func (r *RateLimiter) scheduleProcessing() {
	tokensNeeded := 1 - r.tokens
	waitMs := math.Ceil(tokensNeeded / r.refillRate)
	if waitMs < 0 {
		waitMs = 0
	}
	go r.processAfter(waitMs)
}

// processAfter waits until the limiter clock has advanced by waitMs, then
// processes the queue. With the real clock it sleeps once; with a fake clock it
// polls the injected now() so externally-driven time advances drive processing
// without real sleeps.
func (r *RateLimiter) processAfter(waitMs float64) {
	deadline := r.now().Add(time.Duration(waitMs) * time.Millisecond)
	for r.now().Before(deadline) {
		time.Sleep(pollInterval)
	}
	r.processQueue()
}

// pollInterval is how often processAfter rechecks the clock. It is small enough
// to keep real-clock latency negligible relative to sub-second refill waits and
// to let fake-clock tests progress quickly.
var pollInterval = time.Millisecond

// processQueue reserves tokens for queued waiters in FIFO order, signaling each
// one it can proceed. If waiters remain, it reschedules itself.
func (r *RateLimiter) processQueue() {
	r.mu.Lock()
	r.refill()
	for len(r.queue) > 0 && r.tokens >= 1 {
		w := r.queue[0]
		r.queue = r.queue[1:]
		r.tokens -= 1
		close(w.ready)
	}
	reschedule := len(r.queue) > 0
	if reschedule {
		r.scheduleProcessing()
	}
	r.mu.Unlock()
}
