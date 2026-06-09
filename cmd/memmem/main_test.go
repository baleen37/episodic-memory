package main

import "testing"

func TestRunHelp(t *testing.T) {
	for _, args := range [][]string{nil, {"--help"}, {"-h"}} {
		if code := run(args); code != 0 {
			t.Errorf("run(%v) = %d, want 0", args, code)
		}
	}
}

func TestRunUnknownCommand(t *testing.T) {
	if code := run([]string{"bogus"}); code != 1 {
		t.Errorf("run(bogus) = %d, want 1", code)
	}
}

func TestRunSearchParseError(t *testing.T) {
	// Missing query → parse error → exit 1, no DB access.
	if code := run([]string{"search", "--limit", "5"}); code != 1 {
		t.Errorf("run(search bad) = %d, want 1", code)
	}
}
