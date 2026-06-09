// Package read renders archived transcript content for a given archive path
// and optional line range.
//
// Ports src/core/read.ts. This module is pure Go and CGO-free: it does string
// building (strings.Builder) plus JSON parsing. No markdown library is needed
// because read.ts BUILDS markdown by hand (string concatenation) rather than
// parsing it.
package read

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// formatLocaleNumber mirrors JavaScript Number.prototype.toLocaleString() in the
// en-US locale used by the test environment: integers get comma thousands
// separators (1234 -> "1,234"). The token counts in transcripts are integers,
// so we only group integer values.
func formatLocaleNumber(n int64) string {
	s := strconv.FormatInt(n, 10)
	neg := false
	if strings.HasPrefix(s, "-") {
		neg = true
		s = s[1:]
	}

	if len(s) <= 3 {
		if neg {
			return "-" + s
		}
		return s
	}

	var b strings.Builder
	rem := len(s) % 3
	if rem > 0 {
		b.WriteString(s[:rem])
	}
	for i := rem; i < len(s); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(s[i : i+3])
	}

	out := b.String()
	if neg {
		return "-" + out
	}
	return out
}

// formatTimestamp renders the message-header timestamp.
//
// DELIBERATE DIVERGENCE FROM JS: read.ts uses `new Date(ts).toLocaleString()`,
// which renders in the HOST locale + timezone and is therefore non-reproducible
// — the same transcript renders differently on machines in different timezones.
// For a deterministic, reproducible port (and so Phase 6 E2E can do byte-exact
// comparison against a fixed reference), we render in UTC with a fixed en-US
// shape ("1/1/2024, 12:00:00 PM"). UTC is the defensible deterministic choice:
// the source timestamps are ISO-8601 (usually UTC "Z"), so UTC needs no host
// configuration and is stable across machines. Phase 6 should compare against a
// UTC-normalized reference, not raw JS host-local output.
//
// If the timestamp cannot be parsed, the original string is returned (JS would
// render "Invalid Date"; we prefer the raw value — no test relies on this path).
func formatTimestamp(ts string) string {
	t, err := parseTimestamp(ts)
	if err != nil {
		return ts
	}
	u := t.UTC()
	hour := u.Hour()
	ampm := "AM"
	if hour >= 12 {
		ampm = "PM"
	}
	h12 := hour % 12
	if h12 == 0 {
		h12 = 12
	}
	return strconv.Itoa(int(u.Month())) + "/" +
		strconv.Itoa(u.Day()) + "/" +
		strconv.Itoa(u.Year()) + ", " +
		strconv.Itoa(h12) + ":" +
		pad2(u.Minute()) + ":" +
		pad2(u.Second()) + " " + ampm
}

func parseTimestamp(ts string) (time.Time, error) {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05Z07:00",
		"2006-01-02T15:04:05.999999999Z07:00",
	}
	var firstErr error
	for _, l := range layouts {
		t, err := time.Parse(l, ts)
		if err == nil {
			return t, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return time.Time{}, firstErr
}

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// stringifyJSON mirrors JS JSON.stringify(value, null, 2): 2-space indent and no
// HTML escaping (JS does not escape <, >, &). Object key order is preserved from
// the parsed input by parsing into ordered structures (see jsonValue).
//
// We build compact, guaranteed-unescaped bytes via marshalValue, then reindent
// with json.Indent. We deliberately avoid routing through json.Encoder/Marshal,
// which would re-compact MarshalJSON output with HTML escaping enabled and
// re-escape <, >, & — diverging from JS JSON.stringify.
func stringifyJSON(v jsonValue) string {
	compact, err := marshalValue(v)
	if err != nil {
		return ""
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, compact, "", "  "); err != nil {
		// json.Indent does not unescape, so compact already has the correct
		// (unescaped) bytes; fall back to it on the unlikely indent error.
		return string(compact)
	}
	return buf.String()
}
