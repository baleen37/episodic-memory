package llm

import (
	"context"
	"errors"
	"testing"
)

// stubProvider returns a fixed result, or an error, on each Complete call.
type stubProvider struct {
	text string
	err  error
}

func (s stubProvider) Complete(_ context.Context, _ string, _ Options) (Result, error) {
	if s.err != nil {
		return Result{}, s.err
	}
	return Result{Text: s.text, Usage: TokenUsage{InputTokens: 1, OutputTokens: 1}}, nil
}

func TestRoundRobin_RotatesOnEachSuccessfulCall(t *testing.T) {
	rr, err := NewRoundRobinProvider([]Provider{stubProvider{text: "A"}, stubProvider{text: "B"}})
	if err != nil {
		t.Fatalf("NewRoundRobinProvider: %v", err)
	}
	ctx := context.Background()

	for _, want := range []string{"A", "B", "A"} {
		got, err := rr.Complete(ctx, "p", Options{})
		if err != nil {
			t.Fatalf("Complete: %v", err)
		}
		if got.Text != want {
			t.Fatalf("got %q, want %q", got.Text, want)
		}
	}
}

func TestRoundRobin_FailsOverWhenOneThrows(t *testing.T) {
	failing := stubProvider{err: errors.New("Z.AI API request failed (429): quota")}
	working := stubProvider{text: "B"}
	rr, err := NewRoundRobinProvider([]Provider{failing, working})
	if err != nil {
		t.Fatalf("NewRoundRobinProvider: %v", err)
	}

	got, err := rr.Complete(context.Background(), "p", Options{})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if got.Text != "B" {
		t.Fatalf("got %q, want %q", got.Text, "B")
	}
}

func TestRoundRobin_ThrowsLastErrorWhenAllFail(t *testing.T) {
	a := stubProvider{err: errors.New("429 a")}
	b := stubProvider{err: errors.New("429 b")}
	rr, err := NewRoundRobinProvider([]Provider{a, b})
	if err != nil {
		t.Fatalf("NewRoundRobinProvider: %v", err)
	}

	_, err = rr.Complete(context.Background(), "p", Options{})
	if err == nil || err.Error() != "429 b" {
		t.Fatalf("got err %v, want last error %q", err, "429 b")
	}
}

func TestRoundRobin_RequiresAtLeastOneProvider(t *testing.T) {
	if _, err := NewRoundRobinProvider(nil); err == nil {
		t.Fatal("expected error for empty providers")
	}
}
