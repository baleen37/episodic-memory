package llm

import (
	"strings"
	"testing"
)

// setStubConfig wires SetConfigFileDepsForTests so LoadConfig sees the given
// content (exists=true) or a missing file (exists=false).
func setStubConfig(t *testing.T, exists bool, content string) {
	t.Helper()
	SetConfigFileDepsForTests(
		func(string) bool { return exists },
		func(string) ([]byte, error) { return []byte(content), nil },
	)
	t.Cleanup(func() { SetConfigFileDepsForTests(nil, nil) })
}

func TestLoadConfig_MissingFileReturnsNil(t *testing.T) {
	setStubConfig(t, false, "")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if cfg != nil {
		t.Fatalf("cfg = %+v, want nil", cfg)
	}
}

func TestLoadConfig_ValidGemini(t *testing.T) {
	setStubConfig(t, true, `{"provider":"gemini","apiKey":"test-api-key","model":"gemini-2.0-flash"}`)
	cfg, err := LoadConfig()
	if err != nil || cfg == nil {
		t.Fatalf("cfg=%v err=%v", cfg, err)
	}
	if cfg.Provider != ProviderGemini || cfg.APIKey != "test-api-key" || cfg.Model != "gemini-2.0-flash" {
		t.Fatalf("cfg = %+v", cfg)
	}
}

func TestLoadConfig_ValidZAI(t *testing.T) {
	setStubConfig(t, true, `{"provider":"zai","apiKey":"test-api-key","model":"glm-4.7"}`)
	cfg, err := LoadConfig()
	if err != nil || cfg == nil {
		t.Fatalf("cfg=%v err=%v", cfg, err)
	}
	if cfg.Provider != ProviderZAI {
		t.Fatalf("provider = %q", cfg.Provider)
	}
}

func TestLoadConfig_RateLimitParsed(t *testing.T) {
	setStubConfig(t, true, `{"provider":"gemini","apiKey":"k","ratelimit":{"embedding":{"requestsPerSecond":10,"burstSize":20},"llm":{"requestsPerSecond":3,"burstSize":6}}}`)
	cfg, err := LoadConfig()
	if err != nil || cfg == nil {
		t.Fatalf("cfg=%v err=%v", cfg, err)
	}
	if cfg.RateLimit == nil || cfg.RateLimit.Embedding == nil || cfg.RateLimit.LLM == nil {
		t.Fatalf("ratelimit = %+v", cfg.RateLimit)
	}
	if *cfg.RateLimit.Embedding.RequestsPerSecond != 10 || *cfg.RateLimit.Embedding.BurstSize != 20 {
		t.Fatalf("embedding = %+v", cfg.RateLimit.Embedding)
	}
	if *cfg.RateLimit.LLM.RequestsPerSecond != 3 || *cfg.RateLimit.LLM.BurstSize != 6 {
		t.Fatalf("llm = %+v", cfg.RateLimit.LLM)
	}
}

func TestLoadConfig_PartialRateLimit(t *testing.T) {
	setStubConfig(t, true, `{"provider":"gemini","apiKey":"k","ratelimit":{"embedding":{"requestsPerSecond":10}}}`)
	cfg, err := LoadConfig()
	if err != nil || cfg == nil {
		t.Fatalf("cfg=%v err=%v", cfg, err)
	}
	if *cfg.RateLimit.Embedding.RequestsPerSecond != 10 {
		t.Fatalf("rps = %v", cfg.RateLimit.Embedding.RequestsPerSecond)
	}
	if cfg.RateLimit.LLM != nil {
		t.Fatalf("llm should be nil, got %+v", cfg.RateLimit.LLM)
	}
}

func TestLoadConfig_ProvidersWithoutTopLevelAPIKey(t *testing.T) {
	setStubConfig(t, true, `{"provider":"gemini","providers":[{"apiKey":"key1","model":"gemma-4-31b-it"},{"apiKey":"key2"}]}`)
	cfg, err := LoadConfig()
	if err != nil || cfg == nil {
		t.Fatalf("cfg=%v err=%v", cfg, err)
	}
	if len(cfg.Providers) != 2 || cfg.Providers[0].APIKey != "key1" {
		t.Fatalf("providers = %+v", cfg.Providers)
	}
}

func TestLoadConfig_InvalidCases(t *testing.T) {
	cases := []struct {
		name    string
		content string
	}{
		{"invalid json", "invalid json{"},
		{"missing provider", `{"apiKey":"k","model":"gemini-2.0-flash"}`},
		{"missing apiKey", `{"provider":"gemini","model":"gemini-2.0-flash"}`},
		{"empty provider string", `{"provider":"","apiKey":"k"}`},
		{"unknown provider", `{"provider":"unknown","apiKey":"k"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setStubConfig(t, true, tc.content)
			cfg, err := LoadConfig()
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if cfg != nil {
				t.Fatalf("cfg = %+v, want nil", cfg)
			}
		})
	}
}

func TestCreateProvider_GeminiDefaultModel(t *testing.T) {
	p, err := CreateProvider(Config{Provider: ProviderGemini, APIKey: "k"})
	if err != nil {
		t.Fatalf("CreateProvider: %v", err)
	}
	g, ok := p.(*GeminiProvider)
	if !ok {
		t.Fatalf("type = %T", p)
	}
	if g.model != "gemini-2.0-flash" {
		t.Fatalf("model = %q", g.model)
	}
}

func TestCreateProvider_GeminiSpecifiedModel(t *testing.T) {
	p, err := CreateProvider(Config{Provider: ProviderGemini, APIKey: "k", Model: "gemma-4-31b-it"})
	if err != nil {
		t.Fatalf("CreateProvider: %v", err)
	}
	if p.(*GeminiProvider).model != "gemma-4-31b-it" {
		t.Fatalf("model = %q", p.(*GeminiProvider).model)
	}
}

func TestCreateProvider_ZAI(t *testing.T) {
	p, err := CreateProvider(Config{Provider: ProviderZAI, APIKey: "k"})
	if err != nil {
		t.Fatalf("CreateProvider: %v", err)
	}
	z, ok := p.(*ZAIProvider)
	if !ok {
		t.Fatalf("type = %T", p)
	}
	if z.model != "glm-4.5-air" {
		t.Fatalf("model = %q", z.model)
	}
}

func TestCreateProvider_RoundRobin(t *testing.T) {
	p, err := CreateProvider(Config{
		Provider: ProviderGemini,
		Providers: []ProviderEntry{
			{APIKey: "key1", Model: "gemma-4-31b-it"},
			{APIKey: "key1", Model: "gemma-4-26b-a4b-it"},
			{APIKey: "key2", Model: "gemma-4-31b-it"},
		},
	})
	if err != nil {
		t.Fatalf("CreateProvider: %v", err)
	}
	rr, ok := p.(*RoundRobinProvider)
	if !ok {
		t.Fatalf("type = %T, want *RoundRobinProvider", p)
	}
	if len(rr.providers) != 3 {
		t.Fatalf("providers = %d", len(rr.providers))
	}
}

func TestCreateProvider_EmptyProvidersErrors(t *testing.T) {
	_, err := CreateProvider(Config{Provider: ProviderGemini, Providers: []ProviderEntry{}})
	if err == nil {
		t.Fatal("expected error for empty providers[]")
	}
}

func TestCreateProvider_MissingAPIKeyErrors(t *testing.T) {
	_, err := CreateProvider(Config{Provider: ProviderGemini})
	if err == nil || !strings.Contains(err.Error(), "requires an apiKey") {
		t.Fatalf("err = %v, want 'requires an apiKey'", err)
	}
}

func TestCreateProvider_UnknownProviderErrors(t *testing.T) {
	_, err := CreateProvider(Config{Provider: "bogus", APIKey: "k"})
	if err == nil || !strings.Contains(err.Error(), "Unknown provider") {
		t.Fatalf("err = %v, want 'Unknown provider'", err)
	}
}
