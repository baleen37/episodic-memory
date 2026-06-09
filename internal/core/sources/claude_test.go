package sources

import (
	"strings"
	"testing"
)

// dateParseMillis is the test-side equivalent of JS Date.parse for the ISO-8601
// strings used in the ported fixtures.
func dateParseMillis(t *testing.T, s string) int64 {
	t.Helper()
	ms := parseTimestamp(s)
	if ms == nil {
		t.Fatalf("parseTimestamp(%q) returned nil", s)
	}
	return *ms
}

func strp(s string) *string { return &s }

func TestParseClaudeJsonl_UserAndAssistantIntoSpans(t *testing.T) {
	jsonl := join(
		`{"type":"user","timestamp":"2026-05-26T00:00:00.000Z","sessionId":"s1","cwd":"/repo","gitBranch":"main","message":{"role":"user","content":"How do we sync?"}}`,
		`{"type":"assistant","timestamp":"2026-05-26T00:00:01.000Z","sessionId":"s1","cwd":"/repo","gitBranch":"main","message":{"role":"assistant","content":[{"type":"text","text":"Copy transcripts into archive."}]}}`,
	)

	spans := ParseClaudeJsonl(jsonl, ParseContext{ArchivePath: "/archive/claude-projects/s1.jsonl", SourceKind: "claude-projects"})

	if len(spans) != 1 {
		t.Fatalf("expected 1 span, got %d", len(spans))
	}
	s := spans[0]
	wantText := "User: How do we sync?\nAssistant: Copy transcripts into archive."
	if s.ArchivePath != "/archive/claude-projects/s1.jsonl" ||
		s.SourceKind != "claude-projects" ||
		s.LineStart != 1 || s.LineEnd != 2 ||
		deref(s.SessionID) != "s1" ||
		s.Project != nil ||
		deref(s.Cwd) != "/repo" ||
		deref(s.GitBranch) != "main" ||
		s.Text != wantText {
		t.Fatalf("span mismatch: %+v", s)
	}
	if s.ObservedAt == nil || *s.ObservedAt != dateParseMillis(t, "2026-05-26T00:00:00.000Z") {
		t.Fatalf("observedAt mismatch: %v", s.ObservedAt)
	}
	if !strings.Contains(s.Text, "User: How do we sync?") || !strings.Contains(s.Text, "Assistant: Copy transcripts into archive.") {
		t.Fatalf("text content missing parts: %q", s.Text)
	}
}

func TestParseClaudeJsonl_KeepsToolResultUserInCurrentSpan(t *testing.T) {
	jsonl := join(
		`{"type":"user","timestamp":"2026-05-26T00:00:00.000Z","sessionId":"s1","message":{"role":"user","content":"Inspect the file"}}`,
		`{"type":"assistant","timestamp":"2026-05-26T00:00:01.000Z","sessionId":"s1","message":{"role":"assistant","model":"claude-sonnet","content":[{"type":"text","text":"I will read it."},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"src/core/sources/claude.ts"}}]}}`,
		`{"type":"user","timestamp":"2026-05-26T00:00:02.000Z","sessionId":"s1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"file content"}]}}`,
		`{"type":"assistant","timestamp":"2026-05-26T00:00:03.000Z","sessionId":"s1","message":{"role":"assistant","content":[{"type":"text","text":"The file defines the parser."}]}}`,
	)

	spans := ParseClaudeJsonl(jsonl, ParseContext{ArchivePath: "/archive/claude-projects/s1.jsonl", SourceKind: "claude-projects"})

	if len(spans) != 1 {
		t.Fatalf("expected 1 span, got %d", len(spans))
	}
	s := spans[0]
	want := "User: Inspect the file\nAssistant: I will read it.\nThe file defines the parser."
	if s.Text != want {
		t.Fatalf("text mismatch: %q", s.Text)
	}
	if deref(s.Model) != "claude-sonnet" {
		t.Fatalf("model mismatch: %v", s.Model)
	}
	if s.LineEnd != 4 {
		t.Fatalf("lineEnd mismatch: %d", s.LineEnd)
	}
}

func TestParseClaudeJsonl_EmitsUserOnlySpans(t *testing.T) {
	jsonl := `{"type":"user","timestamp":"2026-05-26T00:00:00.000Z","sessionId":"s1","message":{"role":"user","content":"Run command"}}`

	spans := ParseClaudeJsonl(jsonl, ParseContext{ArchivePath: "/archive/claude-projects/s1.jsonl", SourceKind: "claude-projects"})

	if len(spans) != 1 {
		t.Fatalf("expected 1 span, got %d", len(spans))
	}
	if spans[0].Text != "User: Run command" {
		t.Fatalf("text mismatch: %q", spans[0].Text)
	}
}

func join(lines ...string) string { return strings.Join(lines, "\n") }

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
