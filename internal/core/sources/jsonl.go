package sources

import (
	"encoding/json"
	"strings"
	"time"
)

// jsonObject is a decoded JSON object. Mirrors the TS JsonObject type.
type jsonObject = map[string]any

// asObject returns value as a jsonObject when it is a (non-array, non-null)
// JSON object, else nil. Ports asObject in src/core/sources/jsonl.ts.
//
// With encoding/json, a JSON object decodes to map[string]any, a JSON array to
// []any, JSON null to nil, and scalars to their Go types. So a type assertion
// to map[string]any reproduces the TS check exactly.
func asObject(value any) jsonObject {
	obj, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return obj
}

// asString returns the string value when value is a string, else nil. Ports
// asString in src/core/sources/jsonl.ts (returns string | null).
func asString(value any) *string {
	s, ok := value.(string)
	if !ok {
		return nil
	}
	return &s
}

// parseTimestamp parses an ISO-8601 date string into epoch milliseconds,
// mirroring JavaScript Date.parse. Returns nil for non-strings or unparseable
// strings. Ports parseTimestamp in src/core/sources/jsonl.ts.
func parseTimestamp(value any) *int64 {
	s, ok := value.(string)
	if !ok {
		return nil
	}
	for _, layout := range timestampLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			ms := t.UnixMilli()
			return &ms
		}
	}
	return nil
}

var timestampLayouts = []string{
	time.RFC3339Nano,
	time.RFC3339,
}

// eachJsonLine iterates JSONL content as (object, lineNumber) pairs. Blank
// lines and lines that fail to parse into an object are skipped. lineNumber is
// 1-based. Ports eachJsonLine in src/core/sources/jsonl.ts.
func eachJsonLine(content string, fn func(item jsonObject, lineNumber int64)) {
	// Split on \r?\n: normalize \r\n to \n, then split on \n. This matches the
	// TS regex /\r?\n/ semantics (a trailing lone \r is left on the line and
	// removed by the trim/whitespace check below for blank lines).
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	for index, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var raw any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}
		if item := asObject(raw); item != nil {
			fn(item, int64(index+1))
		}
	}
}
