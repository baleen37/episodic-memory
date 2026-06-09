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

// zaiDefaultModel is the default Z.AI model. Ports the TS DEFAULT_MODEL.
const zaiDefaultModel = "glm-4.5-air"

// zaiDefaultBaseURL is the Z.AI coding API base. Ports the TS DEFAULT_BASE_URL.
const zaiDefaultBaseURL = "https://api.z.ai/api/coding/paas/v4"

// ZAIProvider completes prompts via Z.AI's GLM chat-completions API.
//
// Ports src/core/llm/zai-provider.ts (native fetch → net/http).
type ZAIProvider struct {
	apiKey  string
	model   string
	baseURL string
	client  *http.Client
}

// ZAIOption configures a ZAIProvider (for tests: inject http client/URL).
type ZAIOption func(*ZAIProvider)

// WithZAIHTTPClient overrides the HTTP client (e.g. an httptest client).
func WithZAIHTTPClient(c *http.Client) ZAIOption {
	return func(p *ZAIProvider) {
		if c != nil {
			p.client = c
		}
	}
}

// WithZAIBaseURL overrides the base URL (e.g. an httptest.Server URL).
func WithZAIBaseURL(u string) ZAIOption {
	return func(p *ZAIProvider) {
		if u != "" {
			p.baseURL = u
		}
	}
}

// NewZAIProvider creates a ZAIProvider. An empty model uses the default.
// Returns an error when apiKey is empty, mirroring the TS constructor throw.
func NewZAIProvider(apiKey, model string, opts ...ZAIOption) (*ZAIProvider, error) {
	if apiKey == "" {
		return nil, errors.New("ZAIProvider requires an API key")
	}
	if model == "" {
		model = zaiDefaultModel
	}
	p := &ZAIProvider{
		apiKey:  apiKey,
		model:   model,
		baseURL: zaiDefaultBaseURL,
		client:  http.DefaultClient,
	}
	for _, opt := range opts {
		opt(p)
	}
	return p, nil
}

// zai request/response wire types.

type zaiMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type zaiRequest struct {
	Model       string       `json:"model"`
	Messages    []zaiMessage `json:"messages"`
	Temperature float64      `json:"temperature"`
	MaxTokens   *int         `json:"max_tokens"`
	Stream      bool         `json:"stream"`
}

type zaiUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type zaiChoice struct {
	Index        int    `json:"index"`
	FinishReason string `json:"finish_reason"`
	Message      struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"message"`
}

type zaiResponse struct {
	Choices []zaiChoice `json:"choices"`
	Usage   zaiUsage    `json:"usage"`
}

type zaiErrorResponse struct {
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    string `json:"code"`
	} `json:"error"`
}

// Complete completes prompt via the Z.AI API. Ports complete() in the TS.
func (p *ZAIProvider) Complete(ctx context.Context, prompt string, opts Options) (Result, error) {
	if err := ratelimiter.GetLLMRateLimiter().Acquire(ctx); err != nil {
		return Result{}, err
	}

	messages := make([]zaiMessage, 0, 2)
	if opts.SystemPrompt != "" {
		messages = append(messages, zaiMessage{Role: "system", Content: opts.SystemPrompt})
	}
	messages = append(messages, zaiMessage{Role: "user", Content: prompt})

	reqBody := zaiRequest{
		Model:       p.model,
		Messages:    messages,
		Temperature: 1.0,
		Stream:      false,
	}
	if opts.MaxTokens > 0 {
		mt := opts.MaxTokens
		reqBody.MaxTokens = &mt
	}

	payload, err := json.Marshal(reqBody)
	if err != nil {
		return Result{}, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return Result{}, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+p.apiKey)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept-Language", "en-US,en")

	resp, err := p.client.Do(httpReq)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return Result{}, err
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := http.StatusText(resp.StatusCode)
		var errResp zaiErrorResponse
		if json.Unmarshal(body, &errResp) == nil && errResp.Error != nil && errResp.Error.Message != "" {
			msg = errResp.Error.Message
		}
		return Result{}, fmt.Errorf("Z.AI API request failed (%d): %s", resp.StatusCode, msg)
	}

	var data zaiResponse
	if err := json.Unmarshal(body, &data); err != nil {
		return Result{}, err
	}

	text := ""
	if len(data.Choices) > 0 {
		text = data.Choices[0].Message.Content
	}

	return Result{
		Text: text,
		Usage: TokenUsage{
			InputTokens:  data.Usage.PromptTokens,
			OutputTokens: data.Usage.CompletionTokens,
		},
	}, nil
}
