package search

import (
	"testing"
	"time"
)

func TestValidateISODate(t *testing.T) {
	cases := []struct {
		name    string
		date    string
		param   string
		wantErr string
	}{
		{"valid", "2025-10-01", "--after", ""},
		{"valid leap day", "2024-02-29", "--before", ""},
		{
			"bad format short", "2025-1-1", "--after",
			`Invalid --after date: "2025-1-1". Expected YYYY-MM-DD format (e.g., 2025-10-01)`,
		},
		{
			"bad format slashes", "2025/10/01", "--before",
			`Invalid --before date: "2025/10/01". Expected YYYY-MM-DD format (e.g., 2025-10-01)`,
		},
		{
			"unreal calendar date", "2025-02-30", "--after",
			`Invalid --after date: "2025-02-30". Not a valid calendar date.`,
		},
		{
			"unreal month", "2025-13-01", "--before",
			`Invalid --before date: "2025-13-01". Not a valid calendar date.`,
		},
		{
			"non-leap feb 29", "2025-02-29", "--after",
			`Invalid --after date: "2025-02-29". Not a valid calendar date.`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateISODate(tc.date, tc.param)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error %q, got nil", tc.wantErr)
			}
			if err.Error() != tc.wantErr {
				t.Fatalf("error = %q, want %q", err.Error(), tc.wantErr)
			}
		})
	}
}

func TestIsoToTimestamp(t *testing.T) {
	got := isoToTimestamp("2026-06-01")
	want := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	if got != want {
		t.Fatalf("isoToTimestamp = %d, want %d", got, want)
	}
}

func TestIsoToExclusiveNextDayTimestamp(t *testing.T) {
	// Month-boundary overflow must normalize like Date.UTC: 2026-05-31 -> 2026-06-01.
	got := isoToExclusiveNextDayTimestamp("2026-05-31")
	want := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	if got != want {
		t.Fatalf("nextDay(2026-05-31) = %d, want %d (2026-06-01 midnight)", got, want)
	}
	// Plain next day.
	got = isoToExclusiveNextDayTimestamp("2026-06-01")
	want = time.Date(2026, 6, 2, 0, 0, 0, 0, time.UTC).UnixMilli()
	if got != want {
		t.Fatalf("nextDay(2026-06-01) = %d, want %d", got, want)
	}
}

func TestEscapeLikePattern(t *testing.T) {
	cases := map[string]string{
		`100%`:    `100\%`,
		`a_b`:     `a\_b`,
		`c\d`:     `c\\d`,
		`%_\`:     `\%\_\\`,
		`plain`:   `plain`,
		`한국어`:     `한국어`,
		`50%off_`: `50\%off\_`,
	}
	for in, want := range cases {
		if got := escapeLikePattern(in); got != want {
			t.Errorf("escapeLikePattern(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMakeLikePattern(t *testing.T) {
	if got := makeLikePattern("100%"); got != `%100\%%` {
		t.Fatalf("makeLikePattern = %q", got)
	}
}

func TestBuildFilterParts(t *testing.T) {
	t.Run("no filters", func(t *testing.T) {
		fp := buildFilterParts(Options{})
		if fp.hasFilters || fp.clause != "" || len(fp.params) != 0 {
			t.Fatalf("expected empty filter parts, got %+v", fp)
		}
	})

	t.Run("after before boundaries", func(t *testing.T) {
		fp := buildFilterParts(Options{After: "2026-05-26", Before: "2026-06-01"})
		if !fp.hasFilters {
			t.Fatal("expected hasFilters")
		}
		wantClause := "AND m.observed_at >= ? AND m.observed_at < ?"
		if fp.clause != wantClause {
			t.Fatalf("clause = %q, want %q", fp.clause, wantClause)
		}
		// after >= midnight(after); before < midnight(before+1day).
		wantAfter := time.Date(2026, 5, 26, 0, 0, 0, 0, time.UTC).UnixMilli()
		wantBefore := time.Date(2026, 6, 2, 0, 0, 0, 0, time.UTC).UnixMilli()
		if fp.params[0] != wantAfter {
			t.Errorf("after param = %v, want %d", fp.params[0], wantAfter)
		}
		if fp.params[1] != wantBefore {
			t.Errorf("before param = %v, want %d", fp.params[1], wantBefore)
		}
	})

	t.Run("source kind", func(t *testing.T) {
		fp := buildFilterParts(Options{SourceKind: "codex-sessions"})
		if fp.clause != "AND m.source_kind = ?" {
			t.Fatalf("clause = %q", fp.clause)
		}
		if fp.params[0] != "codex-sessions" {
			t.Fatalf("param = %v", fp.params[0])
		}
	})

	t.Run("projects IN", func(t *testing.T) {
		fp := buildFilterParts(Options{Projects: []string{"alpha", "beta"}})
		if fp.clause != "AND m.project IN (?, ?)" {
			t.Fatalf("clause = %q", fp.clause)
		}
		if len(fp.params) != 2 || fp.params[0] != "alpha" || fp.params[1] != "beta" {
			t.Fatalf("params = %v", fp.params)
		}
	})

	t.Run("files OR-LIKE with escaping", func(t *testing.T) {
		fp := buildFilterParts(Options{Files: []string{"a%.jsonl"}})
		// Two params per file: archive_path pattern + text pattern, both escaped.
		if len(fp.params) != 2 {
			t.Fatalf("params len = %d, want 2", len(fp.params))
		}
		want := `%a\%.jsonl%`
		if fp.params[0] != want || fp.params[1] != want {
			t.Fatalf("file params = %v, want both %q", fp.params, want)
		}
	})

	t.Run("param order: after, sourceKind, projects", func(t *testing.T) {
		fp := buildFilterParts(Options{
			After:      "2026-01-01",
			SourceKind: "claude-projects",
			Projects:   []string{"p1"},
		})
		if len(fp.params) != 3 {
			t.Fatalf("params len = %d", len(fp.params))
		}
		if _, ok := fp.params[0].(int64); !ok {
			t.Errorf("param[0] should be timestamp int64, got %T", fp.params[0])
		}
		if fp.params[1] != "claude-projects" {
			t.Errorf("param[1] = %v", fp.params[1])
		}
		if fp.params[2] != "p1" {
			t.Errorf("param[2] = %v", fp.params[2])
		}
	})
}

func TestTruncateText(t *testing.T) {
	t.Run("short unchanged", func(t *testing.T) {
		s := "hello"
		if got := truncateText(s); got != s {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("exactly 400 unchanged", func(t *testing.T) {
		s := repeat("a", 400)
		if got := truncateText(s); got != s {
			t.Fatalf("len 400 should not truncate, got len %d", len([]rune(got)))
		}
	})

	t.Run("401 truncates to 397+...", func(t *testing.T) {
		s := repeat("a", 401)
		got := truncateText(s)
		if len([]rune(got)) != 400 {
			t.Fatalf("truncated length = %d, want 400", len([]rune(got)))
		}
		if got[len(got)-3:] != "..." {
			t.Fatalf("expected trailing ..., got %q", got[len(got)-3:])
		}
		if got != repeat("a", 397)+"..." {
			t.Fatalf("unexpected truncation")
		}
	})

	t.Run("UTF-16 units for multibyte", func(t *testing.T) {
		// Korean chars are BMP (1 UTF-16 unit each). 401 of them -> truncate.
		s := repeat("가", 401)
		got := truncateText(s)
		// 397 kept code units + "..." -> 397 runes + 3 ascii = 400 runes.
		if r := []rune(got); len(r) != 400 {
			t.Fatalf("rune len = %d, want 400", len(r))
		}
		if got != repeat("가", 397)+"..." {
			t.Fatalf("UTF-16 truncation mismatch")
		}
	})

	t.Run("astral emoji counts as 2 UTF-16 units", func(t *testing.T) {
		// Each 😀 is 2 UTF-16 units. 200 emoji = 400 units -> not truncated.
		s := repeat("😀", 200)
		if got := truncateText(s); got != s {
			t.Fatalf("400 units should not truncate")
		}
		// 201 emoji = 402 units -> truncate. 397 units = 198 full emoji (396) +
		// 1 lone high surrogate, which we drop -> 198 emoji + "...".
		s = repeat("😀", 201)
		got := truncateText(s)
		want := repeat("😀", 198) + "..."
		if got != want {
			t.Fatalf("astral truncation = %q runes, want 198 emoji + ...", got)
		}
	})
}

func repeat(s string, n int) string {
	out := make([]byte, 0, len(s)*n)
	for i := 0; i < n; i++ {
		out = append(out, s...)
	}
	return string(out)
}
