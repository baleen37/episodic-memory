package ratelimiter

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/baleen37/memmem/internal/core/paths"
)

// limiterSection is one limiter's ratelimit config subset.
type limiterSection struct {
	RequestsPerSecond *float64 `json:"requestsPerSecond"`
	BurstSize         *int     `json:"burstSize"`
}

// rateLimitConfig is the ratelimit subset of ~/.config/memmem/config.json. The
// full llm config loader is Phase 3 (internal/llm); only the ratelimit section
// is read here. When Phase 3 lands its loader, loadRateLimitConfig may delegate
// to it instead of reading the file directly.
type rateLimitConfig struct {
	Embedding *limiterSection `json:"embedding"`
	LLM       *limiterSection `json:"llm"`
}

// configFile mirrors the shape of config.json, narrowed to the ratelimit key.
type configFile struct {
	RateLimit *rateLimitConfig `json:"ratelimit"`
}

// loadConfigFn reads the ratelimit config subset. It is a package-level var so
// tests can inject a fake, mirroring the TS __setLoadConfigForTests hook. It
// returns nil when no config is available.
var loadConfigFn = loadRateLimitConfig

// SetLoadConfigForTests overrides the ratelimit config loader. Passing nil
// restores the default file-based loader. Mirrors TS __setLoadConfigForTests.
func SetLoadConfigForTests(fn func() *rateLimitConfig) {
	if fn == nil {
		loadConfigFn = loadRateLimitConfig
		return
	}
	loadConfigFn = fn
}

// loadRateLimitConfig reads the ratelimit section of config.json, returning nil
// if the file is missing or unparseable (the limiter then falls back to
// defaults, matching the TS behavior of treating a null config as defaults).
func loadRateLimitConfig() *rateLimitConfig {
	dir, err := paths.SuperpowersDir()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return nil
	}
	var cf configFile
	if err := json.Unmarshal(data, &cf); err != nil {
		return nil
	}
	return cf.RateLimit
}

// limiterFromSection builds a RateLimiter from a config section, applying RPS
// and burst defaults when fields are absent.
func limiterFromSection(s *limiterSection) *RateLimiter {
	cfg := Config{}
	if s != nil {
		if s.RequestsPerSecond != nil {
			cfg.RequestsPerSecond = *s.RequestsPerSecond
		}
		if s.BurstSize != nil {
			cfg.BurstSize = *s.BurstSize
		}
	}
	return New(cfg)
}

var (
	singletonMu      sync.Mutex
	embeddingLimiter *RateLimiter
	llmLimiter       *RateLimiter
)

// GetEmbeddingRateLimiter returns the lazily-created singleton limiter for
// embedding generation, reading config.ratelimit.embedding (defaults: RPS 0.5,
// burst 1).
func GetEmbeddingRateLimiter() *RateLimiter {
	singletonMu.Lock()
	defer singletonMu.Unlock()
	if embeddingLimiter == nil {
		var section *limiterSection
		if cfg := loadConfigFn(); cfg != nil {
			section = cfg.Embedding
		}
		embeddingLimiter = limiterFromSection(section)
	}
	return embeddingLimiter
}

// GetLLMRateLimiter returns the lazily-created singleton limiter for LLM API
// calls, reading config.ratelimit.llm (defaults: RPS 0.5, burst 1).
func GetLLMRateLimiter() *RateLimiter {
	singletonMu.Lock()
	defer singletonMu.Unlock()
	if llmLimiter == nil {
		var section *limiterSection
		if cfg := loadConfigFn(); cfg != nil {
			section = cfg.LLM
		}
		llmLimiter = limiterFromSection(section)
	}
	return llmLimiter
}

// ResetRateLimiters clears the singletons (test hook), mirroring TS
// resetRateLimiters.
func ResetRateLimiters() {
	singletonMu.Lock()
	defer singletonMu.Unlock()
	embeddingLimiter = nil
	llmLimiter = nil
}
