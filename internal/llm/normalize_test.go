package llm

import "testing"

// TestNormalizeWhitespaceJSParity pins normalizeWhitespace (which feeds the
// extracted record text, part of the on-disk index) to JS semantics computed by
// bun (text.trim().replace(/\s+/g, ' ')). It proves U+0085 (NEL) is kept and
// U+FEFF (BOM) is collapsed/trimmed, matching the TS extractor byte-for-byte.
func TestNormalizeWhitespaceJSParity(t *testing.T) {
	nel := string(rune(0x0085)) // NOT JS \s → kept
	bom := string(rune(0xFEFF)) // JS \s → collapsed
	ideo := string(rune(0x3000))
	cases := []struct{ in, want string }{
		{"x" + nel + "y", "x" + nel + "y"}, // NEL interior kept
		{"x" + bom + "y", "x y"},           // BOM interior collapsed
		{"  a\t\n b" + ideo + "c ", "a b c"},
		{nel + "x" + nel, nel + "x" + nel}, // JS trim does NOT strip NEL edges
		{bom + "x" + bom, "x"},             // JS trim DOES strip BOM edges
	}
	for _, c := range cases {
		if got := normalizeWhitespace(c.in); got != c.want {
			t.Errorf("normalizeWhitespace(%q) = %q, want %q (JS parity)", c.in, got, c.want)
		}
	}
}
