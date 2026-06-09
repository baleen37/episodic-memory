package mcp

import (
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// searchDescription / fetchDescription port the exact tool description strings
// from src/mcp/tools.ts.
const searchDescription = "Search indexed event/fact memory records. Pass a single query string, or an array of 2-5 query strings for multi-query AND search (only records matching every query, ranked by mean similarity). Returns compact memory cards (id, kind, text, score). Call the fetch tool with a result id to read the full source transcript."

const fetchDescription = "Fetch the full source transcript for a memory record returned by search. Takes the record id and returns the original conversation transcript (rendered as markdown) for that memory."

// searchInputSchema ports the JSON Schema in src/mcp/tools.ts searchTool.inputSchema
// faithfully: the query string/array union with the same bounds, limit
// (1..50, default 10), after/before YYYY-MM-DD pattern, source_kind, required
// query, and additionalProperties:false. It is passed verbatim to the client
// via Tool.InputSchema; our own ParseSearchInput performs the actual
// validation server-side (the source_kind property is advertised but unused,
// matching the TS handler).
var searchInputSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "query": {
      "anyOf": [
        { "type": "string", "minLength": 2 },
        { "type": "array", "items": { "type": "string", "minLength": 2 }, "minItems": 2, "maxItems": 5 }
      ],
      "description": "Search query. A single string for normal search, or an array of 2-5 strings for multi-query AND search (returns only records matching ALL queries, scored by mean similarity)."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "default": 10,
      "description": "Maximum number of results to return"
    },
    "after": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "description": "Only return results after this date (YYYY-MM-DD format)"
    },
    "before": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "description": "Only return results before this date (YYYY-MM-DD format)"
    },
    "source_kind": {
      "type": "string",
      "minLength": 1,
      "description": "Filter results to a transcript source kind"
    }
  },
  "required": ["query"],
  "additionalProperties": false
}`)

// fetchInputSchema ports src/mcp/tools.ts fetchTool.inputSchema.
var fetchInputSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "id": {
      "anyOf": [
        { "type": "string", "minLength": 1 },
        { "type": "integer" }
      ],
      "description": "Memory record id from a search result"
    }
  },
  "required": ["id"],
  "additionalProperties": false
}`)

func boolPtr(b bool) *bool { return &b }

// readOnlyAnnotations ports the shared annotation block from src/mcp/tools.ts:
// readOnlyHint:true, destructiveHint:false, idempotentHint:true,
// openWorldHint:false. Title is per-tool.
func readOnlyAnnotations(title string) *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{
		Title:           title,
		ReadOnlyHint:    true,
		DestructiveHint: boolPtr(false),
		IdempotentHint:  true,
		OpenWorldHint:   boolPtr(false),
	}
}

// SearchTool / FetchTool port searchTool / fetchTool from src/mcp/tools.ts.
func SearchTool() *mcp.Tool {
	return &mcp.Tool{
		Name:        "search",
		Description: searchDescription,
		InputSchema: searchInputSchema,
		Annotations: readOnlyAnnotations("Search Memory Records"),
	}
}

func FetchTool() *mcp.Tool {
	return &mcp.Tool{
		Name:        "fetch",
		Description: fetchDescription,
		InputSchema: fetchInputSchema,
		Annotations: readOnlyAnnotations("Fetch Memory Source Transcript"),
	}
}

// AllTools ports allTools = [searchTool, fetchTool].
func AllTools() []*mcp.Tool {
	return []*mcp.Tool{SearchTool(), FetchTool()}
}
