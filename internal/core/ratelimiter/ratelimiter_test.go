package ratelimiter

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeClock is a manually-advanced clock for deterministic refill tests.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{t: time.Unix(0, 0)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

// SetMillis sets the clock to ms milliseconds past the epoch, matching the TS
// setSystemTime(ms) calls.
func (c *fakeClock) SetMillis(ms int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = time.Unix(0, 0).Add(time.Duration(ms) * time.Millisecond)
}

func newTestLimiter(clk *fakeClock, rps float64, burst int) *RateLimiter {
	return New(Config{RequestsPerSecond: rps, BurstSize: burst, Now: clk.Now})
}

// --- Token Bucket Algorithm ---

func TestAllowsRequestsWithinBurstImmediately(t *testing.T) {
	clk := newFakeClock()
	l := newTestLimiter(clk, 2, 2)
	if err := l.Acquire(context.Background()); err != nil {
		t.Fatalf("acquire 1: %v", err)
	}
	if err := l.Acquire(context.Background()); err != nil {
		t.Fatalf("acquire 2: %v", err)
	}
}

func TestDelaysRequestsExceedingBurst(t *testing.T) {
	clk := newFakeClock()
	l := newTestLimiter(clk, 2, 2)
	mustAcquire(t, l)
	mustAcquire(t, l)

	var done atomic.Bool
	go func() {
		_ = l.Acquire(context.Background())
		done.Store(true)
	}()

	// Without time advancing, the third acquire must stay blocked.
	time.Sleep(20 * time.Millisecond)
	if done.Load() {
		t.Fatal("third acquire resolved before refill")
	}

	// Advance fake clock past one refill (rps=2 -> 1 token per 500ms).
	clk.SetMillis(500)
	waitTrue(t, &done, "third acquire did not resolve after refill")
}

func TestTokensRefillOverTime(t *testing.T) {
	clk := newFakeClock()
	l := newTestLimiter(clk, 2, 2)
	mustAcquire(t, l)
	mustAcquire(t, l)

	clk.SetMillis(1000) // 1s -> 2 tokens refilled, capped at burst 2
	mustAcquire(t, l)
	mustAcquire(t, l)
}

func TestTokensDoNotExceedBurst(t *testing.T) {
	clk := newFakeClock()
	l := newTestLimiter(clk, 2, 2)
	mustAcquire(t, l)

	clk.SetMillis(10000) // huge gap, but cap is 2
	mustAcquire(t, l)
	mustAcquire(t, l)

	var done atomic.Bool
	go func() {
		_ = l.Acquire(context.Background())
		done.Store(true)
	}()
	time.Sleep(20 * time.Millisecond)
	if done.Load() {
		t.Fatal("acquire resolved despite bucket capped at burst")
	}
}

// --- Configuration ---

func TestDefaultValues(t *testing.T) {
	l := New(Config{})
	if got := l.AvailableTokens(); got != 1 {
		t.Fatalf("default available tokens = %d, want 1", got)
	}
}

func TestCustomConfiguration(t *testing.T) {
	l := New(Config{RequestsPerSecond: 10, BurstSize: 5})
	if got := l.AvailableTokens(); got != 5 {
		t.Fatalf("available tokens = %d, want 5", got)
	}
}

func TestBurstDefaultsToOne(t *testing.T) {
	l := New(Config{RequestsPerSecond: 3})
	if got := l.AvailableTokens(); got != 1 {
		t.Fatalf("available tokens = %d, want 1", got)
	}
}

// --- TryAcquire ---

func TestTryAcquireTrueWhenAvailable(t *testing.T) {
	clk := newFakeClock()
	l := newTestLimiter(clk, 2, 2)
	if !l.TryAcquire() || !l.TryAcquire() {
		t.Fatal("expected two successful TryAcquire")
	}
}

func TestTryAcquireFalseWhenEmpty(t *testing.T) {
	clk := newFakeClock()
	l := newTestLimiter(clk, 2, 2)
	l.TryAcquire()
	l.TryAcquire()
	if l.TryAcquire() {
		t.Fatal("expected TryAcquire false when empty")
	}
}

func TestTryAcquireDoesNotQueue(t *testing.T) {
	clk := newFakeClock()
	l := newTestLimiter(clk, 2, 2)
	l.TryAcquire()
	l.TryAcquire()
	if l.TryAcquire() || l.TryAcquire() {
		t.Fatal("expected repeated TryAcquire false (no queueing)")
	}
}

// --- AvailableTokens ---

func TestAvailableTokensCount(t *testing.T) {
	clk := newFakeClock()
	l := newTestLimiter(clk, 2, 2)
	if got := l.AvailableTokens(); got != 2 {
		t.Fatalf("start tokens = %d, want 2", got)
	}
	mustAcquire(t, l)
	if got := l.AvailableTokens(); got != 1 {
		t.Fatalf("after 1 acquire = %d, want 1", got)
	}
	mustAcquire(t, l)
	if got := l.AvailableTokens(); got != 0 {
		t.Fatalf("after 2 acquires = %d, want 0", got)
	}
}

func TestAvailableTokensReflectsRefill(t *testing.T) {
	clk := newFakeClock()
	l := newTestLimiter(clk, 2, 2)
	mustAcquire(t, l)
	mustAcquire(t, l)
	if got := l.AvailableTokens(); got != 0 {
		t.Fatalf("emptied = %d, want 0", got)
	}
	clk.SetMillis(500) // rps=2 -> 1 token per 500ms
	if got := l.AvailableTokens(); got != 1 {
		t.Fatalf("after 500ms = %d, want 1", got)
	}
}

// --- Refill math fidelity ---

func TestRefillRateMatchesTS(t *testing.T) {
	clk := newFakeClock()
	// rps=1 -> refillRate 0.001 tokens/ms. burst 5, empty it then advance.
	l := newTestLimiter(clk, 1, 5)
	for i := 0; i < 5; i++ {
		mustAcquire(t, l)
	}
	clk.SetMillis(3000) // 3000ms * 0.001 = 3 tokens
	if got := l.AvailableTokens(); got != 3 {
		t.Fatalf("after 3000ms = %d, want 3", got)
	}
	clk.SetMillis(100000) // cap at burst 5
	if got := l.AvailableTokens(); got != 5 {
		t.Fatalf("capped = %d, want 5", got)
	}
}

// --- ctx cancellation ---

func TestAcquireRespectsContextCancellation(t *testing.T) {
	clk := newFakeClock()
	l := newTestLimiter(clk, 2, 1)
	mustAcquire(t, l) // empty the bucket

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- l.Acquire(ctx) }()

	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case err := <-errCh:
		if err != context.Canceled {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Acquire did not return after ctx cancel")
	}
}

// --- FIFO-ish ordering ---

func TestAcquireFIFOOrder(t *testing.T) {
	clk := newFakeClock()
	l := newTestLimiter(clk, 2, 1)
	mustAcquire(t, l) // empty

	var mu sync.Mutex
	var order []int
	var wg sync.WaitGroup
	// Launch waiters sequentially so queue order is deterministic.
	for i := 0; i < 3; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = l.Acquire(context.Background())
			mu.Lock()
			order = append(order, i)
			mu.Unlock()
		}()
		time.Sleep(10 * time.Millisecond) // ensure enqueue order
	}

	// Advance the clock in 500ms steps (rps=2 -> 1 token per 500ms, burst 1
	// caps each refill at one token) so waiters are released one at a time, in
	// FIFO order. Step until every waiter has completed.
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	step := int64(500)
	for {
		select {
		case <-done:
			goto finished
		default:
		}
		step += 500
		clk.SetMillis(step)
		time.Sleep(10 * time.Millisecond)
	}
finished:

	mu.Lock()
	defer mu.Unlock()
	if len(order) != 3 {
		t.Fatalf("got %d completions, want 3", len(order))
	}
	for i, v := range order {
		if v != i {
			t.Fatalf("FIFO order violated: %v", order)
		}
	}
}

// --- Concurrent stress (race detector) ---

func TestConcurrentTryAcquire(t *testing.T) {
	clk := newFakeClock()
	l := newTestLimiter(clk, 1000, 100)
	var wg sync.WaitGroup
	var acquired atomic.Int64
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				if l.TryAcquire() {
					acquired.Add(1)
				}
				clk.SetMillis(int64(j))
			}
		}()
	}
	wg.Wait()
	_ = acquired.Load()
}

// --- helpers ---

func mustAcquire(t *testing.T, l *RateLimiter) {
	t.Helper()
	if err := l.Acquire(context.Background()); err != nil {
		t.Fatalf("acquire: %v", err)
	}
}

func waitTrue(t *testing.T, b *atomic.Bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if b.Load() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal(msg)
}
