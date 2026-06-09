package mcp

import (
	"encoding/json"
	"testing"
)

// These tests port src/mcp/schemas.test.ts and the schema-validation cases in
// src/mcp/server.test.ts. They are CGO-free (pure JSON parsing/validation).

func parseSearch(t *testing.T, body string) (SearchInput, error) {
	t.Helper()
	return ParseSearchInput(json.RawMessage(body))
}

func parseFetch(t *testing.T, body string) (FetchInput, error) {
	t.Helper()
	return ParseFetchInput(json.RawMessage(body))
}

func TestParseSearchInput_ValidStringQuery(t *testing.T) {
	in, err := parseSearch(t, `{"query":"memory search","limit":5}`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if in.IsArray || in.QueryString != "memory search" || in.Limit != 5 {
		t.Fatalf("got %+v", in)
	}
}

func TestParseSearchInput_RejectsUnknownKey(t *testing.T) {
	// Ports "rejects unknown search filter keys" / "rejects removed source_kind filter".
	if _, err := parseSearch(t, `{"query":"memory search","source_kind":"claude-projects"}`); err == nil {
		t.Fatal("expected error for source_kind extra key")
	}
	if _, err := parseSearch(t, `{"query":"test","unknownParam":"value"}`); err == nil {
		t.Fatal("expected error for unknown key")
	}
}

func TestParseSearchInput_ArrayQueries(t *testing.T) {
	in, err := parseSearch(t, `{"query":["alpha","beta"]}`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !in.IsArray || len(in.QueryArray) != 2 || in.Limit != 10 {
		t.Fatalf("got %+v", in)
	}

	if _, err := parseSearch(t, `{"query":["a1","b2","c3","d4","e5"]}`); err != nil {
		t.Fatalf("5-element array should pass: %v", err)
	}
}

func TestParseSearchInput_ArrayBounds(t *testing.T) {
	if _, err := parseSearch(t, `{"query":["only-one"]}`); err == nil {
		t.Fatal("expected error: array fewer than 2")
	}
	if _, err := parseSearch(t, `{"query":["a1","b2","c3","d4","e5","f6"]}`); err == nil {
		t.Fatal("expected error: array more than 5")
	}
	if _, err := parseSearch(t, `{"query":["ok","x"]}`); err == nil {
		t.Fatal("expected error: too-short string in array")
	}
}

func TestParseSearchInput_QueryStringMinLength(t *testing.T) {
	if _, err := parseSearch(t, `{"query":"a"}`); err == nil {
		t.Fatal("expected error: query shorter than 2")
	}
	if _, err := parseSearch(t, `{"query":""}`); err == nil {
		t.Fatal("expected error: empty query")
	}
}

func TestParseSearchInput_LimitBounds(t *testing.T) {
	for _, ok := range []string{`{"query":"test","limit":1}`, `{"query":"test","limit":50}`} {
		if _, err := parseSearch(t, ok); err != nil {
			t.Fatalf("limit should pass for %s: %v", ok, err)
		}
	}
	for _, bad := range []string{`{"query":"test","limit":0}`, `{"query":"test","limit":51}`, `{"query":"test","limit":10.5}`} {
		if _, err := parseSearch(t, bad); err == nil {
			t.Fatalf("limit should fail for %s", bad)
		}
	}
}

func TestParseSearchInput_DefaultLimit(t *testing.T) {
	in, err := parseSearch(t, `{"query":"test"}`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if in.Limit != 10 {
		t.Fatalf("expected default limit 10, got %d", in.Limit)
	}
}

func TestParseSearchInput_DateFormat(t *testing.T) {
	if _, err := parseSearch(t, `{"query":"test","after":"2024/01/01"}`); err == nil {
		t.Fatal("expected error: invalid after format")
	}
	if _, err := parseSearch(t, `{"query":"test","before":"01-01-2024"}`); err == nil {
		t.Fatal("expected error: invalid before format")
	}
	if _, err := parseSearch(t, `{"query":"test","after":"2024-01-01","before":"2024-12-31"}`); err != nil {
		t.Fatalf("valid dates should pass: %v", err)
	}
	// Format-only validation: invalid month still passes (matches TS).
	if _, err := parseSearch(t, `{"query":"test","after":"2024-13-01"}`); err != nil {
		t.Fatalf("invalid month should still pass format check: %v", err)
	}
}

func TestParseFetchInput_NumericAndString(t *testing.T) {
	in, err := parseFetch(t, `{"id":42}`)
	if err != nil || in.IsString || in.IDNumber != 42 {
		t.Fatalf("numeric id failed: %+v err=%v", in, err)
	}
	in, err = parseFetch(t, `{"id":"42"}`)
	if err != nil || !in.IsString || in.IDString != "42" {
		t.Fatalf("string id failed: %+v err=%v", in, err)
	}
}

func TestParseFetchInput_Rejections(t *testing.T) {
	if _, err := parseFetch(t, `{"id":""}`); err == nil {
		t.Fatal("expected error: empty string id")
	}
	if _, err := parseFetch(t, `{}`); err == nil {
		t.Fatal("expected error: missing id")
	}
	if _, err := parseFetch(t, `{"id":1,"unknownParam":"value"}`); err == nil {
		t.Fatal("expected error: unknown property")
	}
}
