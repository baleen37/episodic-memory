package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/baleen37/memmem/internal/core/ratelimiter"
)

// geminiDefaultModel is the default Gemini model. Ports the TS DEFAULT_MODEL.
const geminiDefaultModel = "gemini-2.0-flash"

// geminiDefaultBaseURL is the Gemini generateContent REST base. The TS used the
// @google/generative-ai SDK, which posts to this v1beta endpoint.
const geminiDefaultBaseURL = "https://generativelanguage.googleapis.com/v1beta"

// GeminiProvider completes prompts via Google's Gemini generateContent REST API.
//
// Ports src/core/llm/gemini-provider.ts. The TS used the SDK; this issues the
// same request directly via net/http to keep the dependency surface minimal and
// match the SDK's wire behavior, including filtering out `thought` parts emitted
// by thinking models.
type GeminiProvider struct {
	apiKey  string
	model   string
	baseURL string
	client  *http.Client
}

// GeminiOption configures a GeminiProvider (for tests: inject http client/URL).
type GeminiOption func(*GeminiProvider)

// WithGeminiHTTPClient overrides the HTTP client (e.g. an httptest client).
func WithGeminiHTTPClient(c *http.Client) GeminiOption {
	return func(p *GeminiProvider) {
		if c != nil {
			p.client = c
		}
	}
}

// WithGeminiBaseURL overrides the base URL (e.g. an httptest.Server URL).
func WithGeminiBaseURL(u string) GeminiOption {
	return func(p *GeminiProvider) {
		if u != "" {
			p.baseURL = u
		}
	}
}

// NewGeminiProvider creates a GeminiProvider. An empty model uses the default.
// Returns an error when apiKey is empty, mirroring the TS constructor throw.
func NewGeminiProvider(apiKey, model string, opts ...GeminiOption) (*GeminiProvider, error) {
	if apiKey == "" {
		return nil, errors.New("GeminiProvider requires an API key")
	}
	if model == "" {
		model = geminiDefaultModel
	}
	p := &GeminiProvider{
		apiKey:  apiKey,
		model:   model,
		baseURL: geminiDefaultBaseURL,
		client:  http.DefaultClient,
	}
	for _, opt := range opts {
		opt(p)
	}
	return p, nil
}

// gemini request/response wire types.

type geminiTextPart struct {
	Text    string `json:"text,omitempty"`
	Thought bool   `json:"thought,omitempty"`
}

type geminiContent struct {
	Parts []geminiTextPart `json:"parts"`
}

type geminiGenerationConfig struct {
	MaxOutputTokens int `json:"maxOutputTokens,omitempty"`
}

type geminiRequest struct {
	Contents          []geminiContent         `json:"contents"`
	SystemInstruction *geminiContent          `json:"systemInstruction,omitempty"`
	GenerationConfig  *geminiGenerationConfig `json:"generationConfig,omitempty"`
}

type geminiUsageMetadata struct {
	PromptTokenCount     int `json:"promptTokenCount"`
	CandidatesTokenCount int `json:"candidatesTokenCount"`
}

type geminiCandidate struct {
	Content geminiContent `json:"content"`
}

type geminiResponse struct {
	Candidates    []geminiCandidate    `json:"candidates"`
	UsageMetadata *geminiUsageMetadata `json:"usageMetadata"`
}

// Complete completes prompt via the Gemini API. Ports complete() in the TS.
func (p *GeminiProvider) Complete(ctx context.Context, prompt string, opts Options) (Result, error) {
	if err := ratelimiter.GetLLMRateLimiter().Acquire(ctx); err != nil {
		return Result{}, err
	}

	reqBody := geminiRequest{
		Contents: []geminiContent{{Parts: []geminiTextPart{{Text: prompt}}}},
	}
	if opts.SystemPrompt != "" {
		reqBody.SystemInstruction = &geminiContent{Parts: []geminiTextPart{{Text: opts.SystemPrompt}}}
	}
	if opts.MaxTokens > 0 {
		reqBody.GenerationConfig = &geminiGenerationConfig{MaxOutputTokens: opts.MaxTokens}
	}

	payload, err := json.Marshal(reqBody)
	if err != nil {
		return Result{}, fmt.Errorf("Gemini API call failed: %w", err)
	}

	url := fmt.Sprintf("%s/models/%s:generateContent?key=%s", p.baseURL, p.model, p.apiKey)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return Result{}, fmt.Errorf("Gemini API call failed: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(httpReq)
	if err != nil {
		return Result{}, fmt.Errorf("Gemini API call failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return Result{}, fmt.Errorf("Gemini API call failed: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("Gemini API call failed: status %d: %s", resp.StatusCode, string(body))
	}

	var parsed geminiResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return Result{}, fmt.Errorf("Gemini API call failed: %w", err)
	}

	return Result{
		Text:  extractGeminiText(parsed),
		Usage: extractGeminiUsage(parsed),
	}, nil
}

// extractGeminiText concatenates the non-thought text parts of the first
// candidate. Thinking models (e.g. Gemma) prefix the real answer with parts
// flagged thought:true, which must be excluded. Ports extractAnswerText().
func extractGeminiText(resp geminiResponse) string {
	if len(resp.Candidates) == 0 {
		return ""
	}
	parts := resp.Candidates[0].Content.Parts
	if len(parts) == 0 {
		return ""
	}
	var b bytes.Buffer
	for _, part := range parts {
		if part.Thought {
			continue
		}
		b.WriteString(part.Text)
	}
	return b.String()
}

// extractGeminiUsage maps usageMetadata to TokenUsage. Gemini reports no cache
// token fields, so those stay nil. Ports extractUsage().
func extractGeminiUsage(resp geminiResponse) TokenUsage {
	usage := TokenUsage{}
	if resp.UsageMetadata != nil {
		usage.InputTokens = resp.UsageMetadata.PromptTokenCount
		usage.OutputTokens = resp.UsageMetadata.CandidatesTokenCount
	}
	return usage
}
