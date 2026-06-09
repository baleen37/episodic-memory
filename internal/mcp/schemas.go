// Package mcp ports src/mcp/: the memmem MCP server surface. It defines the two
// tool schemas (search, fetch), validates their inputs (porting the zod
// strict schemas in src/mcp/schemas.ts), runs the search/fetch handlers
// (src/mcp/handlers.ts), and wires the dispatch + error envelope (src/mcp/server.ts).
//
// Validation is hand-rolled rather than delegated to the go-sdk's generic
// AddTool, so the strict additionalProperties rejection, the query string/array
// union bounds, the YYYY-MM-DD format check, and the exact error messages match
// the TS zod behavior byte-for-byte.
//
// One deliberate divergence from the TS server: unknown-tool calls. The go-sdk
// registers each tool separately and rejects an unadvertised tool name at the
// protocol layer as a JSON-RPC error (code -32602), NOT as a {isError:true}
// content envelope like the TS single-handler dispatch. Conforming MCP clients
// only invoke advertised tools, so this is not observable in practice; the
// Phase 6 MCP E2E equivalence gate should confirm it. See the Dispatch doc and
// TestServer_UnknownTool_WireBehavior.
package mcp

import (
	"encoding/json"
	"fmt"
	"regexp"
)

// dateRegexp ports the zod /^\d{4}-\d{2}-\d{2}$/ guard. It validates format
// only (so 2024-13-01 passes), matching the TS test expectations.
var dateRegexp = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// SearchInput is the parsed, validated search tool input. Ports the zod
// SearchInputSchema. Query is either a single string or a 2-5 element array;
// exactly one of QueryString / QueryArray is set. Limit defaults to 10.
type SearchInput struct {
	QueryString string
	QueryArray  []string
	IsArray     bool
	Limit       int
	After       string
	Before      string
}

// FetchInput is the parsed, validated fetch tool input. Ports the zod
// FetchInputSchema. Exactly one of IDString / IDNumber is set.
type FetchInput struct {
	IDString string
	IDNumber float64
	IsString bool
}

// validationError is returned for any input that fails the schema. Its message
// is wrapped by the server into the "Error: <message>" envelope.
type validationError struct{ msg string }

func (e *validationError) Error() string { return e.msg }

func verr(format string, args ...any) error {
	return &validationError{msg: fmt.Sprintf(format, args...)}
}

// ParseSearchInput validates raw tool arguments against SearchInputSchema.
// Ports z.object({...}).strict(): the query union (string min2 | array(string
// min2) min2..max5), limit (int 1..50 default 10), optional after/before
// YYYY-MM-DD, and strict rejection of unknown keys.
func ParseSearchInput(raw json.RawMessage) (SearchInput, error) {
	fields, err := decodeObject(raw)
	if err != nil {
		return SearchInput{}, err
	}

	allowed := map[string]struct{}{"query": {}, "limit": {}, "after": {}, "before": {}}
	if err := rejectUnknown(fields, allowed); err != nil {
		return SearchInput{}, err
	}

	in := SearchInput{Limit: 10}

	queryRaw, ok := fields["query"]
	if !ok {
		return SearchInput{}, verr("query: Required")
	}
	if err := parseQuery(queryRaw, &in); err != nil {
		return SearchInput{}, err
	}

	if limitRaw, ok := fields["limit"]; ok {
		limit, err := parseLimit(limitRaw)
		if err != nil {
			return SearchInput{}, err
		}
		in.Limit = limit
	}

	if afterRaw, ok := fields["after"]; ok {
		v, err := parseDate(afterRaw, "after")
		if err != nil {
			return SearchInput{}, err
		}
		in.After = v
	}
	if beforeRaw, ok := fields["before"]; ok {
		v, err := parseDate(beforeRaw, "before")
		if err != nil {
			return SearchInput{}, err
		}
		in.Before = v
	}

	return in, nil
}

// parseQuery ports the z.union([z.string().min(2), z.array(z.string().min(2)).min(2).max(5)]).
func parseQuery(raw json.RawMessage, in *SearchInput) error {
	// Try string first.
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if len(s) < 2 {
			return verr("query: String must contain at least 2 character(s)")
		}
		in.QueryString = s
		in.IsArray = false
		return nil
	}
	// Try array.
	var arr []string
	if err := json.Unmarshal(raw, &arr); err == nil {
		if len(arr) < 2 {
			return verr("query: Array must contain at least 2 element(s)")
		}
		if len(arr) > 5 {
			return verr("query: Array must contain at most 5 element(s)")
		}
		for _, item := range arr {
			if len(item) < 2 {
				return verr("query: String must contain at least 2 character(s)")
			}
		}
		in.QueryArray = arr
		in.IsArray = true
		return nil
	}
	return verr("query: Expected string or array of strings")
}

// parseLimit ports z.number().int().min(1).max(50). JSON numbers decode as
// float64; a non-integer (10.5) is rejected.
func parseLimit(raw json.RawMessage) (int, error) {
	var n float64
	if err := json.Unmarshal(raw, &n); err != nil {
		return 0, verr("limit: Expected number")
	}
	if n != float64(int(n)) {
		return 0, verr("limit: Expected integer")
	}
	v := int(n)
	if v < 1 {
		return 0, verr("limit: Number must be greater than or equal to 1")
	}
	if v > 50 {
		return 0, verr("limit: Number must be less than or equal to 50")
	}
	return v, nil
}

func parseDate(raw json.RawMessage, field string) (string, error) {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", verr("%s: Expected string", field)
	}
	if !dateRegexp.MatchString(s) {
		return "", verr("%s: Invalid", field)
	}
	return s, nil
}

// ParseFetchInput validates raw tool arguments against FetchInputSchema. Ports
// z.object({ id: z.union([z.string().min(1), z.number().int()]) }).strict().
func ParseFetchInput(raw json.RawMessage) (FetchInput, error) {
	fields, err := decodeObject(raw)
	if err != nil {
		return FetchInput{}, err
	}

	if err := rejectUnknown(fields, map[string]struct{}{"id": {}}); err != nil {
		return FetchInput{}, err
	}

	idRaw, ok := fields["id"]
	if !ok {
		return FetchInput{}, verr("id: Required")
	}

	var in FetchInput
	var s string
	if err := json.Unmarshal(idRaw, &s); err == nil {
		if len(s) < 1 {
			return FetchInput{}, verr("id: String must contain at least 1 character(s)")
		}
		in.IDString = s
		in.IsString = true
		return in, nil
	}
	var n float64
	if err := json.Unmarshal(idRaw, &n); err == nil {
		if n != float64(int64(n)) {
			return FetchInput{}, verr("id: Expected integer")
		}
		in.IDNumber = n
		in.IsString = false
		return in, nil
	}
	return FetchInput{}, verr("id: Expected string or number")
}

// decodeObject unmarshals raw JSON arguments into a field map. A nil/empty body
// is treated as an empty object (matching the TS handling of missing args).
func decodeObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	if len(raw) == 0 {
		return map[string]json.RawMessage{}, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, verr("Expected object")
	}
	return fields, nil
}

// rejectUnknown ports the zod .strict() behavior: any key outside the allowed
// set fails validation.
func rejectUnknown(fields map[string]json.RawMessage, allowed map[string]struct{}) error {
	for key := range fields {
		if _, ok := allowed[key]; !ok {
			return verr("Unrecognized key(s) in object: '%s'", key)
		}
	}
	return nil
}
