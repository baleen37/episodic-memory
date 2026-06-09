// Package llm is the LLM provider layer used by the indexer's extractor.
//
// Ports src/core/llm/ (types.ts, config.ts, gemini-provider.ts, zai-provider.ts,
// round-robin-provider.ts, index.ts). Everything sits behind the Provider
// interface; LoadConfig returns nil when unconfigured, and CreateProvider
// supports single-provider and providers[] round-robin modes.
//
// This layer is pure Go (CGO-free): providers make HTTP calls via net/http and
// parse JSON with encoding/json.
package llm

import "context"

// TokenUsage reports token consumption for an LLM call.
//
// Ports the TS TokenUsage interface. Cache fields are optional in TS (undefined
// when unsupported); in Go they default to 0 when a provider does not report
// them. Pointers preserve the present/absent distinction where it matters.
type TokenUsage struct {
	// InputTokens is the number of input (prompt) tokens consumed.
	InputTokens int
	// OutputTokens is the number of output (completion) tokens generated.
	OutputTokens int
	// CacheReadInputTokens is the number of cache-read input tokens, when the
	// provider reports it (nil otherwise).
	CacheReadInputTokens *int
	// CacheCreationInputTokens is the number of cache-creation input tokens,
	// when the provider reports it (nil otherwise).
	CacheCreationInputTokens *int
}

// Options configures a single completion request. Ports the TS LLMOptions.
type Options struct {
	// MaxTokens caps the generated tokens. Zero means "unset" (provider default).
	MaxTokens int
	// SystemPrompt, when non-empty, guides the model's behavior.
	SystemPrompt string
}

// Result is the outcome of a completion request. Ports the TS LLMResult.
type Result struct {
	// Text is the generated completion text.
	Text string
	// Usage is the token usage for this request.
	Usage TokenUsage
}

// Provider completes prompts via an LLM backend. Ports the TS LLMProvider
// interface; a context is added per Go HTTP conventions (the TS had none).
type Provider interface {
	// Complete completes prompt using the provider, honoring opts.
	Complete(ctx context.Context, prompt string, opts Options) (Result, error)
}
