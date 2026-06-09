package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const zaiSuccessBody = `{
  "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "Test response"}}],
  "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
}`

func newZAI(t *testing.T, srv *httptest.Server) *ZAIProvider {
	t.Helper()
	p, err := NewZAIProvider("test-api-key", "", WithZAIBaseURL(srv.URL), WithZAIHTTPClient(srv.Client()))
	if err != nil {
		t.Fatalf("NewZAIProvider: %v", err)
	}
	return p
}

func zaiServer(t *testing.T, body string, capture *http.Request, captureBody *[]byte) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if capture != nil {
			*capture = *r
		}
		if captureBody != nil {
			b, _ := io.ReadAll(r.Body)
			*captureBody = b
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestZAI_ConstructorRequiresAPIKey(t *testing.T) {
	if _, err := NewZAIProvider("", ""); err == nil {
		t.Fatal("expected error for missing API key")
	}
}

func TestZAI_DefaultModel(t *testing.T) {
	p, err := NewZAIProvider("k", "")
	if err != nil {
		t.Fatalf("NewZAIProvider: %v", err)
	}
	if p.model != "glm-4.5-air" {
		t.Fatalf("default model = %q, want glm-4.5-air", p.model)
	}
}

func TestZAI_ReturnsTextAndUsage(t *testing.T) {
	srv := zaiServer(t, zaiSuccessBody, nil, nil)
	res, err := newZAI(t, srv).Complete(context.Background(), "test prompt", Options{})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if res.Text != "Test response" {
		t.Fatalf("text = %q", res.Text)
	}
	if res.Usage.InputTokens != 10 || res.Usage.OutputTokens != 5 {
		t.Fatalf("usage = %+v", res.Usage)
	}
	if res.Usage.CacheReadInputTokens != nil || res.Usage.CacheCreationInputTokens != nil {
		t.Fatal("cache fields should be nil for zai")
	}
}

func TestZAI_RequestShape(t *testing.T) {
	var gotReq http.Request
	var gotBody []byte
	srv := zaiServer(t, zaiSuccessBody, &gotReq, &gotBody)

	_, err := newZAI(t, srv).Complete(context.Background(), "hello", Options{
		MaxTokens:    2048,
		SystemPrompt: "You are helpful.",
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if !strings.HasSuffix(gotReq.URL.Path, "/chat/completions") {
		t.Fatalf("path = %q", gotReq.URL.Path)
	}
	if got := gotReq.Header.Get("Authorization"); got != "Bearer test-api-key" {
		t.Fatalf("Authorization = %q", got)
	}

	var body zaiRequest
	if err := json.Unmarshal(gotBody, &body); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}
	if body.Model != "glm-4.5-air" {
		t.Fatalf("model = %q", body.Model)
	}
	if len(body.Messages) != 2 || body.Messages[0].Role != "system" || body.Messages[1].Role != "user" {
		t.Fatalf("messages = %+v", body.Messages)
	}
	if body.Messages[1].Content != "hello" {
		t.Fatalf("user content = %q", body.Messages[1].Content)
	}
	if body.MaxTokens == nil || *body.MaxTokens != 2048 {
		t.Fatalf("max_tokens = %v", body.MaxTokens)
	}
	// Verify raw body carries "max_tokens":2048 and "role":"system" (TS asserts).
	if !strings.Contains(string(gotBody), `"max_tokens":2048`) {
		t.Fatalf("body missing max_tokens: %s", gotBody)
	}
	if !strings.Contains(string(gotBody), `"role":"system"`) {
		t.Fatalf("body missing system role: %s", gotBody)
	}
}

func TestZAI_NoSystemPromptOmitsSystemMessage(t *testing.T) {
	var gotBody []byte
	srv := zaiServer(t, zaiSuccessBody, nil, &gotBody)

	_, err := newZAI(t, srv).Complete(context.Background(), "hi", Options{})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	var body zaiRequest
	if err := json.Unmarshal(gotBody, &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(body.Messages) != 1 || body.Messages[0].Role != "user" {
		t.Fatalf("messages = %+v", body.Messages)
	}
}

func TestZAI_ErrorOnRequestFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":{"message":"Invalid API key"}}`)
	}))
	t.Cleanup(srv.Close)

	_, err := newZAI(t, srv).Complete(context.Background(), "x", Options{})
	if err == nil || !strings.Contains(err.Error(), "Z.AI API request failed") {
		t.Fatalf("err = %v, want Z.AI API request failed", err)
	}
	if !strings.Contains(err.Error(), "Invalid API key") {
		t.Fatalf("err should include API message: %v", err)
	}
}

func TestZAI_ErrorFallsBackToStatusText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `not json`)
	}))
	t.Cleanup(srv.Close)

	_, err := newZAI(t, srv).Complete(context.Background(), "x", Options{})
	if err == nil || !strings.Contains(err.Error(), "Internal Server Error") {
		t.Fatalf("err = %v, want statusText fallback", err)
	}
}
