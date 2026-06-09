package llm

import (
	"context"
	"errors"
)

// RoundRobinProvider wraps multiple providers and rotates between them on each
// call, failing over to the next on error so a 429/quota error advances to the
// next (apiKey, model) combination.
//
// Ports src/core/llm/round-robin-provider.ts.
type RoundRobinProvider struct {
	providers []Provider
	cursor    int
}

// NewRoundRobinProvider creates a RoundRobinProvider. Returns an error when no
// providers are given, mirroring the TS constructor throw.
func NewRoundRobinProvider(providers []Provider) (*RoundRobinProvider, error) {
	if len(providers) == 0 {
		return nil, errors.New("RoundRobinProvider requires at least one provider")
	}
	return &RoundRobinProvider{providers: providers}, nil
}

// Complete tries each provider once, starting at the cursor and advancing on
// every attempt, returning the first success or the last error if all fail.
// Ports complete() in the TS: cursor advances per attempt (so successive calls
// rotate), and a failure fails over to the next provider.
func (r *RoundRobinProvider) Complete(ctx context.Context, prompt string, opts Options) (Result, error) {
	var lastErr error
	n := len(r.providers)
	for i := 0; i < n; i++ {
		provider := r.providers[r.cursor]
		r.cursor = (r.cursor + 1) % n
		result, err := provider.Complete(ctx, prompt, opts)
		if err != nil {
			lastErr = err
			continue
		}
		return result, nil
	}
	return Result{}, lastErr
}
