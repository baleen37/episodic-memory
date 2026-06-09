package indexer

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
)

// whitespaceRe collapses runs of whitespace. JS \s also covers Unicode spaces,
// so \p{Zs} and the common control whitespace are included for parity with the
// TS makeDedupeKey normalize (text.toLowerCase().replace(/\s+/g, ' ').trim()).
var whitespaceRe = regexp.MustCompile(`[\t\n\v\f\r \x85\xA0\p{Zs}\p{Zl}\p{Zp}]+`)

// hashText returns the lowercase hex sha256 of text. Ports hashText.
func hashText(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// makeDedupeKey returns sha256hex of `${kind}:${normalized}` where normalized is
// the text lowercased, with whitespace runs collapsed to single spaces, trimmed.
// This must match the TS makeDedupeKey exactly: it is a DB unique-constraint
// component, so index compatibility depends on byte-for-byte agreement.
// Ports makeDedupeKey.
func makeDedupeKey(kind, text string) string {
	lowered := strings.ToLower(text)
	collapsed := whitespaceRe.ReplaceAllString(lowered, " ")
	normalized := kind + ":" + strings.TrimSpace(collapsed)
	return hashText(normalized)
}
