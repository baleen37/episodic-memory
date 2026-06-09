package cli

import (
	"strings"
	"testing"
)

func TestParseSearchArgs(t *testing.T) {
	got, err := ParseSearchArgs([]string{
		"search", "semantic memory",
		"--after", "2026-05-01",
		"--source-kind", "codex-sessions",
		"--limit", "5",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := SearchArgs{Query: "semantic memory", After: "2026-05-01", SourceKind: "codex-sessions", Limit: 5}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseSearchArgsMultiToken(t *testing.T) {
	got, err := ParseSearchArgs([]string{"search", "semantic", "memory", "--limit", "5"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Query != "semantic memory" || got.Limit != 5 {
		t.Fatalf("got %+v", got)
	}
}

func TestParseSearchArgsErrors(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"invalid numeric", []string{"search", "semantic memory", "--limit", "0"}, "--limit must be a positive integer"},
		{"missing value", []string{"search", "semantic memory", "--after"}, "--after requires a value"},
		{"empty query", []string{"search", "--limit", "5"}, "search requires a query"},
		{"unknown option", []string{"search", "q", "--nope"}, "Unknown option: --nope"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseSearchArgs(tc.args)
			if err == nil || err.Error() != tc.want {
				t.Fatalf("got %v, want %q", err, tc.want)
			}
		})
	}
}

func TestParseReadArgs(t *testing.T) {
	got, err := ParseReadArgs([]string{"read", "/archive/session.jsonl", "--start-line", "3", "--end-line", "8"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := ReadArgs{Path: "/archive/session.jsonl", StartLine: 3, EndLine: 8}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseReadArgsErrors(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"missing path", []string{"read"}, "read requires a path"},
		{"flag as path", []string{"read", "--start-line", "3"}, "read requires a path"},
		{"missing both lines", []string{"read", "/a.jsonl"}, "read requires --start-line and --end-line"},
		{"missing end", []string{"read", "/a.jsonl", "--start-line", "3"}, "read requires --start-line and --end-line"},
		{"missing start", []string{"read", "/a.jsonl", "--end-line", "8"}, "read requires --start-line and --end-line"},
		{"invalid numeric", []string{"read", "/a.jsonl", "--start-line", "0"}, "--start-line must be a positive integer"},
		{"start after end", []string{"read", "/a.jsonl", "--start-line", "9", "--end-line", "8"}, "--start-line must be less than or equal to --end-line"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseReadArgs(tc.args)
			if err == nil || err.Error() != tc.want {
				t.Fatalf("got %v, want %q", err, tc.want)
			}
		})
	}
}

func TestHelpText(t *testing.T) {
	help := HelpText()
	wants := []string{
		"sync", "search", "read", "stats", "verify",
		"memmem - Event/fact memory for Claude Code and Codex transcripts",
		"sync      Copy transcripts and extract memory records",
		"search    Search indexed memory records",
		"read      Read archived transcript lines",
		"stats     Print memory index statistics",
		"verify    Verify memory index integrity",
		"--limit <number>",
		"--after <YYYY-MM-DD>",
		"--before <YYYY-MM-DD>",
		"--source-kind <kind>",
		"--start-line <number>",
		"--end-line <number>",
		`memmem search "source of truth" --limit 5`,
		"memmem read /archive/session.jsonl --start-line 3 --end-line 8",
	}
	for _, w := range wants {
		if !strings.Contains(help, w) {
			t.Errorf("help missing %q", w)
		}
	}
	if strings.Contains(help, "recall") {
		t.Errorf("help should not contain 'recall'")
	}
}
