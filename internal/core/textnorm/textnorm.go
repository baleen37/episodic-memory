// Package textnorm provides whitespace normalization that is byte-for-byte
// identical to JavaScript's String semantics. It exists so the TS↔Go index stays
// compatible: both the extracted record text (via the llm extractor) and the
// dedupe_key (via the indexer) are derived from this normalization and are part
// of the on-disk index, so any divergence from JS produces incompatible rows.
package textnorm

import (
	"regexp"
	"strings"
)

// jsWhitespace matches a run of characters in JavaScript's `\s` set, which is
// also exactly JS's trim() WhiteSpace∪LineTerminator set.
//
// Expressed via Unicode classes: \p{Zs} covers U+00A0, U+1680, U+2000-200A,
// U+202F, U+205F, U+3000; \p{Zl}=U+2028; \p{Zp}=U+2029; plus the ASCII control
// whitespace and U+FEFF (BOM/ZWNBSP). Crucially this MUST include U+FEFF
// (JS `\s` collapses it) and MUST NOT include U+0085/NEL (JS `\s` does not —
// U+0085 is category Cc, not in \p{Zs}, so it is kept verbatim).
var jsWhitespace = regexp.MustCompile(`[\t\n\v\f\r \p{Zs}\p{Zl}\p{Zp}\x{FEFF}]+`)

// jsTrimRunes is the JS trim() character set (identical to JS `\s`). Built from
// explicit code points so no invisible literal can drift. Used instead of
// strings.TrimSpace, whose unicode.IsSpace set diverges from JS (it includes
// U+0085 and excludes U+FEFF).
var jsTrimRunes = []rune{
	'\t', '\n', '\v', '\f', '\r', ' ',
	0x00A0, 0x1680,
	0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A,
	0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
}

var trimCutset = string(jsTrimRunes)

// TrimJS trims leading/trailing JS-`\s` characters, matching JavaScript trim().
func TrimJS(s string) string {
	return strings.Trim(s, trimCutset)
}

// CollapseWhitespace replaces every run of JS-`\s` characters with a single
// ASCII space, matching JavaScript text.replace(/\s+/g, ' ').
func CollapseWhitespace(s string) string {
	return jsWhitespace.ReplaceAllString(s, " ")
}

// Normalize mirrors the TS normalizeWhitespace: text.trim().replace(/\s+/g, ' ').
// (Order is trim-then-collapse, matching the extractor; the collapse step makes
// any interior run a single space and the trim handles the edges.)
func Normalize(s string) string {
	return CollapseWhitespace(TrimJS(s))
}
