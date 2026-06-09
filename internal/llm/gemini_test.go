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

func newGemini(t *testing.T, srv *httptest.Server) *GeminiProvider {
	t.Helper()
	p, err := NewGeminiProvider("test-api-key", "", WithGeminiBaseURL(srv.URL), WithGeminiHTTPClient(srv.Client()))
	if err != nil {
		t.Fatalf("NewGeminiProvider: %v", err)
	}
	return p
}

func geminiServer(t *testing.T, body string, capture *http.Request, captureBody *[]byte) *httptest.Server {
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

const geminiSuccessBody = `{
  "candidates": [{"content": {"parts": [{"text": "Test response"}]}}],
  "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5, "totalTokenCount": 15}
}`

func TestGemini_ConstructorRequiresAPIKey(t *testing.T) {
	if _, err := NewGeminiProvider("", ""); err == nil {
		t.Fatal("expected error for missing API key")
	}
}

func TestGemini_DefaultModel(t *testing.T) {
	p, err := NewGeminiProvider("k", "")
	if err != nil {
		t.Fatalf("NewGeminiProvider: %v", err)
	}
	if p.model != "gemini-2.0-flash" {
		t.Fatalf("default model = %q, want gemini-2.0-flash", p.model)
	}
}

func TestGemini_ReturnsTextAndUsage(t *testing.T) {
	srv := geminiServer(t, geminiSuccessBody, nil, nil)
	res, err := newGemini(t, srv).Complete(context.Background(), "test prompt", Options{})
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
		t.Fatal("cache fields should be nil for gemini")
	}
}

func TestGemini_RequestShape(t *testing.T) {
	var gotReq http.Request
	var gotBody []byte
	srv := geminiServer(t, geminiSuccessBody, &gotReq, &gotBody)

	_, err := newGemini(t, srv).Complete(context.Background(), "hello", Options{
		MaxTokens:    2048,
		SystemPrompt: "You are helpful.",
	})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if !strings.Contains(gotReq.URL.Path, "/models/gemini-2.0-flash:generateContent") {
		t.Fatalf("path = %q", gotReq.URL.Path)
	}
	if got := gotReq.URL.Query().Get("key"); got != "test-api-key" {
		t.Fatalf("key query = %q", got)
	}

	var body geminiRequest
	if err := json.Unmarshal(gotBody, &body); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}
	if len(body.Contents) != 1 || len(body.Contents[0].Parts) != 1 || body.Contents[0].Parts[0].Text != "hello" {
		t.Fatalf("contents = %+v", body.Contents)
	}
	if body.SystemInstruction == nil || body.SystemInstruction.Parts[0].Text != "You are helpful." {
		t.Fatalf("systemInstruction = %+v", body.SystemInstruction)
	}
	if body.GenerationConfig == nil || body.GenerationConfig.MaxOutputTokens != 2048 {
		t.Fatalf("generationConfig = %+v", body.GenerationConfig)
	}
}

func TestGemini_OmitsOptionalRequestFields(t *testing.T) {
	var gotBody []byte
	srv := geminiServer(t, geminiSuccessBody, nil, &gotBody)

	_, err := newGemini(t, srv).Complete(context.Background(), "hi", Options{})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if strings.Contains(string(gotBody), "systemInstruction") {
		t.Fatalf("systemInstruction should be omitted: %s", gotBody)
	}
	if strings.Contains(string(gotBody), "generationConfig") {
		t.Fatalf("generationConfig should be omitted: %s", gotBody)
	}
}

func TestGemini_ExcludesThoughtParts(t *testing.T) {
	body := `{
      "candidates": [{"content": {"parts": [
        {"thought": true, "text": "*   Goal: extract records"},
        {"thought": false, "text": "[{\"kind\":\"fact\",\"text\":\"x\"}]"}
      ]}}],
      "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 20}
    }`
	srv := geminiServer(t, body, nil, nil)
	res, err := newGemini(t, srv).Complete(context.Background(), "extract", Options{})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if res.Text != `[{"kind":"fact","text":"x"}]` {
		t.Fatalf("text = %q, want only the non-thought answer", res.Text)
	}
}

func TestGemini_ErrorOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":{"message":"bad request"}}`)
	}))
	t.Cleanup(srv.Close)

	p := newGemini(t, srv)
	_, err := p.Complete(context.Background(), "x", Options{})
	if err == nil || !strings.Contains(err.Error(), "Gemini API call failed") {
		t.Fatalf("err = %v, want Gemini API call failed", err)
	}
}
