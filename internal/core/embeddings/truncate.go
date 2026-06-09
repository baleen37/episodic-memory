package embeddings

import "unicode/utf16"

// truncateUTF16 returns the prefix of s containing at most maxUnits UTF-16 code
// units, matching JavaScript's String.prototype.substring(0, maxUnits).
//
// JS strings are sequences of UTF-16 code units. text.substring(0, 8000) keeps
// the first 8000 code units, where a BMP character is 1 unit and an astral
// character (e.g. most emoji) is 2 units (a surrogate pair). The TS embedding
// pipeline (src/core/embeddings-model.ts) truncates with substring before
// prefixing, so we must reproduce UTF-16-unit semantics — not Go byte length
// (UTF-8) and not rune count — or long multilingual inputs would tokenize
// differently and produce vectors incompatible with the existing on-disk index.
//
// If truncation would land in the middle of a surrogate pair (i.e. maxUnits cuts
// an astral character in half), the trailing lone high surrogate is dropped,
// which is also what JS substring produces (a string ending in an unpaired
// surrogate; we decode it back to a valid Go string by discarding it). This edge
// is exercised by truncate_test.go.
func truncateUTF16(s string, maxUnits int) string {
	if maxUnits <= 0 {
		return ""
	}
	// Fast path: ASCII-only or short strings whose rune count (<= unit count)
	// is already within the limit can't exceed maxUnits.
	units := utf16.Encode([]rune(s))
	if len(units) <= maxUnits {
		return s
	}
	kept := units[:maxUnits]
	// If the cut split a surrogate pair, the last kept unit is an unpaired high
	// surrogate (0xD800..0xDBFF). utf16.Decode would turn it into U+FFFD; instead
	// drop it so the result is the valid prefix of complete characters. JS
	// substring would keep the lone surrogate (an invalid string), but that half
	// of an astral char carries no usable content for the tokenizer, and the set
	// of *complete* characters preserved is identical.
	if n := len(kept); n > 0 && kept[n-1] >= 0xD800 && kept[n-1] <= 0xDBFF {
		kept = kept[:n-1]
	}
	return string(utf16.Decode(kept))
}
