package ratelimiter

import "testing"

func f64(v float64) *float64 { return &v }
func ip(v int) *int          { return &v }

func setupConfigTest(t *testing.T, cfg *rateLimitConfig) {
	t.Helper()
	SetLoadConfigForTests(func() *rateLimitConfig { return cfg })
	ResetRateLimiters()
	t.Cleanup(func() {
		SetLoadConfigForTests(nil)
		ResetRateLimiters()
	})
}

// --- Factory Functions ---

func TestGetEmbeddingRateLimiterSingleton(t *testing.T) {
	setupConfigTest(t, nil)
	if GetEmbeddingRateLimiter() != GetEmbeddingRateLimiter() {
		t.Fatal("embedding limiter not singleton")
	}
}

func TestGetLLMRateLimiterSingleton(t *testing.T) {
	setupConfigTest(t, nil)
	if GetLLMRateLimiter() != GetLLMRateLimiter() {
		t.Fatal("llm limiter not singleton")
	}
}

func TestEmbeddingAndLLMSeparate(t *testing.T) {
	setupConfigTest(t, nil)
	if GetEmbeddingRateLimiter() == GetLLMRateLimiter() {
		t.Fatal("embedding and llm limiters should be separate")
	}
}

// --- Config Integration ---

func TestEmbeddingDefaultsWhenNoConfig(t *testing.T) {
	setupConfigTest(t, nil)
	if got := GetEmbeddingRateLimiter().AvailableTokens(); got != 1 {
		t.Fatalf("default embedding tokens = %d, want 1", got)
	}
}

func TestEmbeddingUsesConfig(t *testing.T) {
	setupConfigTest(t, &rateLimitConfig{
		Embedding: &limiterSection{RequestsPerSecond: f64(10), BurstSize: ip(25)},
	})
	if got := GetEmbeddingRateLimiter().AvailableTokens(); got != 25 {
		t.Fatalf("embedding tokens = %d, want 25", got)
	}
}

func TestLLMDefaultsWhenNoConfig(t *testing.T) {
	setupConfigTest(t, nil)
	if got := GetLLMRateLimiter().AvailableTokens(); got != 1 {
		t.Fatalf("default llm tokens = %d, want 1", got)
	}
}

func TestLLMUsesConfig(t *testing.T) {
	setupConfigTest(t, &rateLimitConfig{
		LLM: &limiterSection{RequestsPerSecond: f64(5), BurstSize: ip(15)},
	})
	if got := GetLLMRateLimiter().AvailableTokens(); got != 15 {
		t.Fatalf("llm tokens = %d, want 15", got)
	}
}

func TestEmbeddingDefaultBurstWhenOnlyRPS(t *testing.T) {
	setupConfigTest(t, &rateLimitConfig{
		Embedding: &limiterSection{RequestsPerSecond: f64(8)},
	})
	if got := GetEmbeddingRateLimiter().AvailableTokens(); got != 1 {
		t.Fatalf("embedding tokens = %d, want 1", got)
	}
}

func TestLLMDefaultBurstWhenOnlyRPS(t *testing.T) {
	setupConfigTest(t, &rateLimitConfig{
		LLM: &limiterSection{RequestsPerSecond: f64(3)},
	})
	if got := GetLLMRateLimiter().AvailableTokens(); got != 1 {
		t.Fatalf("llm tokens = %d, want 1", got)
	}
}

func TestBothLimitersSeparateConfig(t *testing.T) {
	setupConfigTest(t, &rateLimitConfig{
		Embedding: &limiterSection{RequestsPerSecond: f64(10), BurstSize: ip(30)},
		LLM:       &limiterSection{RequestsPerSecond: f64(1), BurstSize: ip(2)},
	})
	if got := GetEmbeddingRateLimiter().AvailableTokens(); got != 30 {
		t.Fatalf("embedding tokens = %d, want 30", got)
	}
	if got := GetLLMRateLimiter().AvailableTokens(); got != 2 {
		t.Fatalf("llm tokens = %d, want 2", got)
	}
}
