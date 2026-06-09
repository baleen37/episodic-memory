package llm

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/baleen37/memmem/internal/core/ratelimiter"
)

// TestMain points the shared LLM rate limiter at a generous config so the many
// provider.Complete calls in this package's tests don't serialize behind the
// default 0.5 RPS / burst-1 limiter (which would add ~2s per call). Providers
// acquire from the singleton on every call; tests assert wire behavior, not
// rate limiting, so a high RPS keeps them fast and deterministic.
//
// It writes a temp config.json and points CONVERSATION_MEMORY_CONFIG_DIR at it
// (the path the ratelimiter reads), using only public surfaces. No real network
// and no mutation of the user's on-disk config.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "memmem-llm-test")
	if err != nil {
		panic(err)
	}
	const cfg = `{"provider":"gemini","apiKey":"x","ratelimit":{"llm":{"requestsPerSecond":100000,"burstSize":100000}}}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(cfg), 0o644); err != nil {
		panic(err)
	}
	os.Setenv("CONVERSATION_MEMORY_CONFIG_DIR", dir)
	ratelimiter.ResetRateLimiters()

	code := m.Run()

	os.Unsetenv("CONVERSATION_MEMORY_CONFIG_DIR")
	ratelimiter.ResetRateLimiters()
	os.RemoveAll(dir)
	os.Exit(code)
}
