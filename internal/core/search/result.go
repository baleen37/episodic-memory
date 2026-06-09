package search

import "unicode/utf16"

// MemorySearchResult is a compact, source-linked memory card. Ports the TS
// MemorySearchResult interface. Nullable TS fields (`number | null`) map to
// pointers; the optional `score?` maps to *float64 (set only on the vector
// path, where a distance is available).
type MemorySearchResult struct {
	ID          int64
	Kind        string
	Text        string
	SourceKind  string
	ArchivePath string
	LineStart   int64
	LineEnd     int64
	ObservedAt  *int64
	Project     *string
	Score       *float64
}

// MemoryRecordLocation is the provenance triple for reading raw transcript
// lines. Ports the TS MemoryRecordLocation interface.
type MemoryRecordLocation struct {
	ArchivePath string
	LineStart   int64
	LineEnd     int64
}

// maxTextLen / textTruncateLen port the TS mapRow truncation thresholds:
// text.length > 400 -> text.slice(0, 397) + "...". Lengths are UTF-16 code
// units (JS .length / .slice semantics).
const (
	maxTextLen      = 400
	textTruncateLen = 397
)

// truncateText ports mapRow's text truncation. JS measures String.length and
// String.slice in UTF-16 code units, so a multibyte/astral character counts as
// 1 or 2 units. We replicate that (rather than Go byte or rune length) to match
// the TS output byte-for-byte for multilingual text.
func truncateText(text string) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= maxTextLen {
		return text
	}
	kept := units[:textTruncateLen]
	// JS slice(0, 397) keeps a lone high surrogate if the cut splits a pair; we
	// drop it to decode to a valid Go string. The set of complete characters is
	// identical, which is what the truncated preview conveys.
	if n := len(kept); n > 0 && kept[n-1] >= 0xD800 && kept[n-1] <= 0xDBFF {
		kept = kept[:n-1]
	}
	return string(utf16.Decode(kept)) + "..."
}

// rowFields holds the raw columns selected for a memory record, plus the
// optional vector distance. It mirrors the object mapRow consumes in TS.
type rowFields struct {
	id          int64
	kind        string
	text        string
	archivePath string
	lineStart   int64
	lineEnd     int64
	sourceKind  string
	project     *string
	observedAt  *int64
	distance    *float64
}

// mapRow ports mapRow: it truncates long text and, when a distance is present
// (vector path), sets score = 1 / (1 + distance).
func mapRow(r rowFields) MemorySearchResult {
	res := MemorySearchResult{
		ID:          r.id,
		Kind:        r.kind,
		Text:        truncateText(r.text),
		SourceKind:  r.sourceKind,
		ArchivePath: r.archivePath,
		LineStart:   r.lineStart,
		LineEnd:     r.lineEnd,
		ObservedAt:  r.observedAt,
		Project:     r.project,
	}
	if r.distance != nil {
		score := 1.0 / (1.0 + *r.distance)
		res.Score = &score
	}
	return res
}
