package sources

import (
	"strings"
	"testing"
)

func TestParseCodexJsonl_ResponseItemsIntoSpans(t *testing.T) {
	jsonl := join(
		`{"type":"session_meta","payload":{"id":"codex-session","cwd":"/repo","git":{"branch":"main"},"model":"gpt-5.1","provider":"openai"}}`,
		`{"type":"response_item","timestamp":"2026-05-26T00:00:00.000Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Run tests"}]}}`,
		`{"type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"shell","arguments":"{\"cmd\":\"bun test\"}"}}`,
		`{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"pass"}}`,
		`{"type":"response_item","timestamp":"2026-05-26T00:00:01.000Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Tests passed."}]}}`,
	)

	spans := ParseCodexJsonl(jsonl, ParseContext{ArchivePath: "/archive/codex-sessions/rollout.jsonl", SourceKind: "codex-sessions"})

	if len(spans) != 1 {
		t.Fatalf("expected 1 span, got %d", len(spans))
	}
	s := spans[0]
	wantText := "User: Run tests\nAssistant: Tests passed."
	if s.ArchivePath != "/archive/codex-sessions/rollout.jsonl" ||
		s.SourceKind != "codex-sessions" ||
		s.LineStart != 2 || s.LineEnd != 5 ||
		deref(s.SessionID) != "codex-session" ||
		s.Project != nil ||
		deref(s.Cwd) != "/repo" ||
		deref(s.GitBranch) != "main" ||
		deref(s.Model) != "gpt-5.1" ||
		deref(s.Provider) != "codex" ||
		deref(s.MetadataJSON) != `{"source":"codex"}` ||
		s.Text != wantText {
		t.Fatalf("span mismatch: %+v", s)
	}
	if s.ObservedAt == nil || *s.ObservedAt != dateParseMillis(t, "2026-05-26T00:00:00.000Z") {
		t.Fatalf("observedAt mismatch: %v", s.ObservedAt)
	}
	if !strings.Contains(s.Text, "User: Run tests") || !strings.Contains(s.Text, "Assistant: Tests passed.") {
		t.Fatalf("text content missing parts: %q", s.Text)
	}
}

func TestParseCodexJsonl_ToolVariantsHidden(t *testing.T) {
	jsonl := join(
		`{"type":"session_meta","payload":{"id":"codex-session","cwd":"/old","model_provider":"openai"}}`,
		`{"type":"turn_context","payload":{"cwd":"/repo","model":"gpt-5.2"}}`,
		`{"type":"response_item","timestamp":"2026-05-26T00:00:00.000Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Search and run"}]}}`,
		`{"type":"response_item","payload":{"type":"custom_tool_call","id":"custom-1","name":"apply_patch","input":{"patch":"diff"}}}`,
		`{"type":"response_item","payload":{"type":"custom_tool_call_output","id":"custom-1","output":"patched"}}`,
		`{"type":"response_item","payload":{"type":"tool_search_call","call_id":"search-1","query":"parser"}}`,
		`{"type":"response_item","payload":{"type":"tool_search_call_output","call_id":"search-1","output":[{"path":"src/core/sources/codex.ts"}]}}`,
		`{"type":"response_item","payload":{"type":"local_shell_call","call_id":"shell-1","action":{"cmd":"bun test src/core/sources"}}}`,
		`{"type":"response_item","payload":{"type":"local_shell_call_output","call_id":"shell-1","output":"pass"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done."}]}}`,
	)

	spans := ParseCodexJsonl(jsonl, ParseContext{ArchivePath: "/archive/codex-sessions/rollout.jsonl", SourceKind: "codex-sessions"})

	if len(spans) != 1 {
		t.Fatalf("expected 1 span, got %d", len(spans))
	}
	s := spans[0]
	if deref(s.Model) != "gpt-5.2" || deref(s.Provider) != "codex" {
		t.Fatalf("meta mismatch: %+v", s)
	}
	if s.ObservedAt == nil || *s.ObservedAt != dateParseMillis(t, "2026-05-26T00:00:00.000Z") {
		t.Fatalf("observedAt mismatch: %v", s.ObservedAt)
	}
	if s.Text != "User: Search and run\nAssistant: Done." {
		t.Fatalf("text mismatch: %q", s.Text)
	}
}

func TestParseCodexJsonl_SnapshotsTurnContextPerSpan(t *testing.T) {
	jsonl := join(
		`{"type":"session_meta","payload":{"id":"codex-session","model_provider":"openai"}}`,
		`{"type":"turn_context","payload":{"cwd":"/repo-a","model":"model-a"}}`,
		`{"type":"response_item","timestamp":"2026-05-26T00:00:00.000Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"First"}]}}`,
		`{"type":"response_item","timestamp":"2026-05-26T00:00:01.000Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"First done."}]}}`,
		`{"type":"turn_context","payload":{"cwd":"/repo-b","model":"model-b"}}`,
		`{"type":"response_item","timestamp":"2026-05-26T00:00:02.000Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Second"}]}}`,
		`{"type":"response_item","timestamp":"2026-05-26T00:00:03.000Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Second done."}]}}`,
	)

	spans := ParseCodexJsonl(jsonl, ParseContext{ArchivePath: "/archive/codex-sessions/rollout.jsonl", SourceKind: "codex-sessions"})

	if len(spans) != 2 {
		t.Fatalf("expected 2 spans, got %d", len(spans))
	}
	if deref(spans[0].Model) != "model-a" || spans[0].Text != "User: First\nAssistant: First done." ||
		*spans[0].ObservedAt != dateParseMillis(t, "2026-05-26T00:00:00.000Z") {
		t.Fatalf("span0 mismatch: %+v", spans[0])
	}
	if deref(spans[1].Model) != "model-b" || spans[1].Text != "User: Second\nAssistant: Second done." ||
		*spans[1].ObservedAt != dateParseMillis(t, "2026-05-26T00:00:02.000Z") {
		t.Fatalf("span1 mismatch: %+v", spans[1])
	}
}

func TestParseCodexJsonl_CwdFromSessionMeta(t *testing.T) {
	jsonl := join(
		`{"type":"session_meta","payload":{"id":"s1","cwd":"/Users/me/dev/acme/gadget"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"yo"}]}}`,
	)

	spans := ParseCodexJsonl(jsonl, ParseContext{ArchivePath: "/archive/codex-sessions/s1.jsonl", SourceKind: "codex-sessions"})

	if len(spans) != 1 {
		t.Fatalf("expected 1 span, got %d", len(spans))
	}
	if deref(spans[0].Cwd) != "/Users/me/dev/acme/gadget" {
		t.Fatalf("cwd mismatch: %v", spans[0].Cwd)
	}
}
