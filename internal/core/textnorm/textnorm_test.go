package textnorm

import "testing"

var (
	nel  = string(rune(0x0085)) // U+0085 NEL — NOT in JS \s, must be kept
	bom  = string(rune(0xFEFF)) // U+FEFF BOM/ZWNBSP — in JS \s, must be collapsed
	nbsp = string(rune(0x00A0))
	ideo = string(rune(0x3000)) // ideographic space
	lsep = string(rune(0x2028)) // line separator
	psep = string(rune(0x2029)) // paragraph separator
	nnbs = string(rune(0x202F)) // narrow no-break space
)

func TestCollapseWhitespaceJSParity(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		// U+0085 NEL is NOT JS whitespace → kept verbatim, not collapsed.
		{"nel kept", "a" + nel + "b", "a" + nel + "b"},
		// U+FEFF BOM IS JS whitespace → collapsed to a single space.
		{"bom collapsed", "a" + bom + "b", "a b"},
		{"ascii run", "a\t\n  b", "a b"},
		{"nbsp", "a" + nbsp + "b", "a b"},
		{"ideographic space U+3000", "a" + ideo + "b", "a b"},
		{"line sep U+2028", "a" + lsep + "b", "a b"},
		{"para sep U+2029", "a" + psep + "b", "a b"},
		{"narrow nbsp U+202F", "a" + nnbs + "b", "a b"},
	}
	for _, c := range cases {
		if got := CollapseWhitespace(c.in); got != c.want {
			t.Errorf("%s: CollapseWhitespace(%q) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
}

func TestTrimJSParity(t *testing.T) {
	// JS trim() keeps leading/trailing U+0085, removes U+FEFF.
	if got := TrimJS(nel + "x" + nel); got != nel+"x"+nel {
		t.Errorf("TrimJS keeps NEL edges: got %q", got)
	}
	if got := TrimJS(bom + "x" + bom); got != "x" {
		t.Errorf("TrimJS removes BOM edges: got %q", got)
	}
	if got := TrimJS("  \t x \n "); got != "x" {
		t.Errorf("TrimJS ascii edges: got %q", got)
	}
}

func TestNormalizeJSParity(t *testing.T) {
	// Mirrors JS text.trim().replace(/\s+/g, ' ').
	cases := []struct{ in, want string }{
		{"x" + nel + "y", "x" + nel + "y"},   // NEL interior kept
		{"x" + bom + "y", "x y"},             // BOM interior collapsed
		{"  a\t\n b" + ideo + "c ", "a b c"}, // mixed ascii + U+3000
		{nel + "x" + nel, nel + "x" + nel},   // NEL edges kept (JS trim does not strip NEL)
		{bom + "x" + bom, "x"},               // BOM edges trimmed
	}
	for _, c := range cases {
		if got := Normalize(c.in); got != c.want {
			t.Errorf("Normalize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
