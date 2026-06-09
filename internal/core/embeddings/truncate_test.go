package embeddings

import (
	"strings"
	"testing"
	"unicode/utf16"
)

// jsSubstring reproduces JavaScript's String.prototype.substring(0, n) exactly,
// including keeping a trailing lone high surrogate when the cut splits a
// surrogate pair. It operates on UTF-16 code units and returns the resulting
// code-unit slice (which may not be valid UTF-16, just like a JS string).
func jsSubstringUnits(s string, n int) []uint16 {
	units := utf16.Encode([]rune(s))
	if n > len(units) {
		n = len(units)
	}
	if n < 0 {
		n = 0
	}
	return units[:n]
}

func TestTruncateUTF16_KoreanBoundaryMatchesJS(t *testing.T) {
	// 10000 Korean chars: 10000 UTF-16 units, 30000 UTF-8 bytes. A byte-based
	// truncation (the PoC bug) would cut at ~2666 chars; UTF-16 keeps 8000.
	in := strings.Repeat("가", 10000)
	got := truncateUTF16(in, MaxContentChars)

	wantRunes := []rune(in)[:MaxContentChars] // each Korean char = 1 UTF-16 unit
	want := string(wantRunes)
	if got != want {
		t.Fatalf("korean truncation mismatch: got %d runes, want %d", len([]rune(got)), MaxContentChars)
	}
	if got == in {
		t.Fatal("expected truncation but got full string")
	}
	// Parity with JS substring(0, 8000) decoded to a Go string.
	jsWant := string(utf16.Decode(jsSubstringUnits(in, MaxContentChars)))
	if got != jsWant {
		t.Fatalf("korean truncation != JS substring(0,8000)")
	}
}

func TestTruncateUTF16_AstralFullyKept(t *testing.T) {
	// 7998 'a' + 😀 (2 UTF-16 units) = exactly 8000 units. The emoji must
	// survive intact, matching JS substring(0,8000) which keeps the full pair.
	in := strings.Repeat("a", 7998) + "😀"
	got := truncateUTF16(in, MaxContentChars)
	if got != in {
		t.Fatalf("expected emoji kept intact; got len %d units", len(utf16.Encode([]rune(got))))
	}
	if !strings.HasSuffix(got, "😀") {
		t.Fatal("expected result to end with full emoji")
	}
}

func TestTruncateUTF16_AstralSplitBoundary(t *testing.T) {
	// 7999 'a' + 😀 = 8001 units. substring(0,8000) splits the emoji's surrogate
	// pair: JS keeps the 7999 'a' plus a lone high surrogate (d83d). We drop the
	// unpaired surrogate (it cannot round-trip through UTF-8 and is meaningless
	// to the tokenizer), so the kept *complete* characters are the 7999 'a' —
	// identical character content to what JS preserves before the broken half.
	in := strings.Repeat("a", 7999) + "😀"

	// Confirm the test setup matches the JS boundary: JS keeps a trailing d83d.
	jsUnits := jsSubstringUnits(in, MaxContentChars)
	if len(jsUnits) != MaxContentChars {
		t.Fatalf("setup: expected JS substring length %d, got %d", MaxContentChars, len(jsUnits))
	}
	if jsUnits[len(jsUnits)-1] != 0xd83d {
		t.Fatalf("setup: expected JS to keep lone high surrogate d83d, got %x", jsUnits[len(jsUnits)-1])
	}

	got := truncateUTF16(in, MaxContentChars)
	want := strings.Repeat("a", 7999)
	if got != want {
		t.Fatalf("split-boundary truncation: got %q-tail (%d runes), want 7999 'a'", lastRunes(got, 4), len([]rune(got)))
	}
}

func TestTruncateUTF16_ShortStringUnchanged(t *testing.T) {
	for _, s := range []string{"", "hello", "한국어와 영어가 섞인 검색 쿼리 테스트", "😀🎉"} {
		if got := truncateUTF16(s, MaxContentChars); got != s {
			t.Fatalf("short string altered: %q -> %q", s, got)
		}
	}
}

func TestTruncateUTF16_ByteVsUTF16Diverge(t *testing.T) {
	// Regression guard for the PoC gap: byte-length truncation would cut Korean
	// text much earlier than UTF-16-unit truncation.
	in := strings.Repeat("가", 10000)
	if len(in) <= MaxContentChars {
		t.Fatal("setup: expected UTF-8 byte length > MaxContentChars")
	}
	byteTrunc := in[:MaxContentChars] // the buggy PoC behavior
	utf16Trunc := truncateUTF16(in, MaxContentChars)
	if byteTrunc == utf16Trunc {
		t.Fatal("expected byte- and UTF-16-truncation to differ for Korean text")
	}
	if len([]rune(utf16Trunc)) != MaxContentChars {
		t.Fatalf("UTF-16 truncation kept %d runes, want %d", len([]rune(utf16Trunc)), MaxContentChars)
	}
}

func lastRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[len(r)-n:])
}
