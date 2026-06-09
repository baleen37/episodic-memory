package llm

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// ProviderType enumerates the supported LLM providers. Ports LLMProviderType.
type ProviderType string

const (
	ProviderGemini ProviderType = "gemini"
	ProviderZAI    ProviderType = "zai"
)

// defaultModels maps each provider to its default model. Ports DEFAULT_MODELS.
var defaultModels = map[ProviderType]string{
	ProviderGemini: geminiDefaultModel,
	ProviderZAI:    zaiDefaultModel,
}

// RateLimitConfig is one limiter's config. Ports the TS RateLimitConfig.
type RateLimitConfig struct {
	RequestsPerSecond *float64 `json:"requestsPerSecond,omitempty"`
	BurstSize         *int     `json:"burstSize,omitempty"`
}

// RateLimitsConfig groups the per-subsystem limiter configs. Ports
// RateLimitsConfig.
type RateLimitsConfig struct {
	Embedding *RateLimitConfig `json:"embedding,omitempty"`
	LLM       *RateLimitConfig `json:"llm,omitempty"`
}

// ProviderEntry is one (apiKey, model) combination for round-robin rotation.
// Ports the TS ProviderEntry.
type ProviderEntry struct {
	// Email optionally labels the account that issued the key (informational).
	Email string `json:"email,omitempty"`
	// APIKey is the provider API key.
	APIKey string `json:"apiKey"`
	// Model optionally overrides the provider default.
	Model string `json:"model,omitempty"`
}

// Config is the parsed ~/.config/memmem/config.json llm section. Ports LLMConfig.
type Config struct {
	// Provider is "gemini" or "zai".
	Provider ProviderType `json:"provider"`
	// APIKey is the single-provider-mode API key.
	APIKey string `json:"apiKey,omitempty"`
	// Model optionally overrides the provider default.
	Model string `json:"model,omitempty"`
	// Providers, when non-empty, switches to round-robin mode.
	Providers []ProviderEntry `json:"providers,omitempty"`
	// RateLimit optionally configures rate limiters.
	RateLimit *RateLimitsConfig `json:"ratelimit,omitempty"`
}

// configFileDeps abstracts the two filesystem calls loadConfig needs, so tests
// can inject fakes. Mirrors the TS __setConfigFileDepsForTests hook.
type configFileDeps struct {
	exists   func(path string) bool
	readFile func(path string) ([]byte, error)
}

func defaultConfigFileDeps() configFileDeps {
	return configFileDeps{
		exists: func(path string) bool {
			_, err := os.Stat(path)
			return err == nil
		},
		readFile: os.ReadFile,
	}
}

var fileDeps = defaultConfigFileDeps()

// SetConfigFileDepsForTests overrides the filesystem dependencies used by
// LoadConfig. Passing nil functions restores the default. Mirrors the TS
// __setConfigFileDepsForTests.
func SetConfigFileDepsForTests(exists func(path string) bool, readFile func(path string) ([]byte, error)) {
	if exists == nil || readFile == nil {
		fileDeps = defaultConfigFileDeps()
		return
	}
	fileDeps = configFileDeps{exists: exists, readFile: readFile}
}

// LoadConfig reads and validates ~/.config/memmem/config.json.
//
// Returns (nil, nil) when the file is missing or invalid (logging a warning),
// mirroring the TS loadConfig which warns and returns null. The error result is
// reserved for future use; callers treating nil as "unconfigured" match TS.
func LoadConfig() (*Config, error) {
	configPath := filepath.Join(os.Getenv("HOME"), ".config", "memmem", "config.json")

	if !fileDeps.exists(configPath) {
		return nil, nil
	}

	data, err := fileDeps.readFile(configPath)
	if err != nil {
		log.Printf("Failed to load config from %s: %v", configPath, err)
		return nil, nil
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		log.Printf("Failed to load config from %s: %v", configPath, err)
		return nil, nil
	}

	// Either a single apiKey or a non-empty providers[] must be present.
	hasProviders := len(cfg.Providers) > 0
	if cfg.Provider == "" || (cfg.APIKey == "" && !hasProviders) {
		log.Printf("Invalid config: missing provider or apiKey field")
		return nil, nil
	}

	if cfg.Provider != ProviderGemini && cfg.Provider != ProviderZAI {
		log.Printf("Invalid config: unknown provider %q", cfg.Provider)
		return nil, nil
	}

	return &cfg, nil
}

// CreateProvider builds a Provider from config. Ports the TS createProvider.
//
//   - When Providers is non-nil, build one provider per entry (recursively) and
//     wrap them in a RoundRobinProvider. An empty Providers slice is an error,
//     matching TS where the truthy [] still enters the round-robin branch.
//   - Otherwise APIKey is required ("Provider requires an apiKey"); the model
//     defaults per provider; "gemini"→GeminiProvider, "zai"→ZAIProvider;
//     anything else is an "Unknown provider" error.
func CreateProvider(cfg Config) (Provider, error) {
	if cfg.Providers != nil {
		built := make([]Provider, 0, len(cfg.Providers))
		for _, entry := range cfg.Providers {
			p, err := CreateProvider(Config{
				Provider: cfg.Provider,
				APIKey:   entry.APIKey,
				Model:    entry.Model,
			})
			if err != nil {
				return nil, err
			}
			built = append(built, p)
		}
		return NewRoundRobinProvider(built)
	}

	if cfg.APIKey == "" {
		return nil, fmt.Errorf("Provider requires an apiKey")
	}

	model := cfg.Model
	if model == "" {
		model = defaultModels[cfg.Provider]
	}

	switch cfg.Provider {
	case ProviderGemini:
		return NewGeminiProvider(cfg.APIKey, model)
	case ProviderZAI:
		return NewZAIProvider(cfg.APIKey, model)
	default:
		return nil, fmt.Errorf("Unknown provider: %s", cfg.Provider)
	}
}
