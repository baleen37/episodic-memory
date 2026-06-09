package indexer

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/baleen37/memmem/internal/core/textnorm"
)

// hashText returns the lowercase hex sha256 of text. Ports hashText.
func hashText(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// makeDedupeKey returns sha256hex of `${kind}:${normalized}` where normalized is
// the text lowercased, with whitespace runs collapsed to single spaces, trimmed.
// This must match the TS makeDedupeKey exactly
// (text.toLowerCase().replace(/\s+/g, ' ').trim()): it is a DB unique-constraint
// component, so index compatibility depends on byte-for-byte agreement. The
// whitespace handling is shared via textnorm to match JS `\s` (U+FEFF collapsed,
// U+0085 kept) and JS trim().
func makeDedupeKey(kind, text string) string {
	lowered := strings.ToLower(text)
	normalized := kind + ":" + textnorm.TrimJS(textnorm.CollapseWhitespace(lowered))
	return hashText(normalized)
}
