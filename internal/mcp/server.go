package mcp

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/baleen37/memmem/internal/core/db"
	"github.com/baleen37/memmem/internal/core/paths"
	gomcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// serverName / serverVersion port the TS Server({ name: 'memmem', version: '3.0.0' }).
const (
	serverName    = "memmem"
	serverVersion = "3.0.0"
)

// DBFactory opens a fresh database handle per tool call. Ports the TS
// `openDatabase()` call inside CallTool. Tests inject an in-memory DB factory.
type DBFactory func() (*sql.DB, error)

// openProductionDB ports openDatabase(): resolve the configured DB path and open it.
func openProductionDB() (*sql.DB, error) {
	dbPath, err := paths.DBPath()
	if err != nil {
		return nil, err
	}
	return db.OpenDatabase(dbPath)
}

// HandleError ports handleError(error): Error instances and other values both
// render as "Error: <message>".
func HandleError(err error) string {
	return "Error: " + err.Error()
}

// Dispatch ports the CallTool request handler in src/mcp/server.ts. It validates
// args against the tool's schema, opens a DB (closed in a defer), runs the
// handler, and returns the MCP CallToolResult. On ANY error it returns the
// {content:[{text: handleError(err)}], isError:true} envelope.
//
// DIVERGENCE — unknown tool names: over real stdio the go-sdk registers each
// tool separately (see NewServer) and rejects an unadvertised tool name at the
// PROTOCOL layer as a JSON-RPC error (code -32602, "unknown tool ...") BEFORE
// this function runs. The TS server (a single CallToolRequestSchema handler
// with string dispatch) instead returns "Error: Unknown tool: <name>" inside an
// {isError:true} content envelope. We deliberately do NOT fight the go-sdk to
// reproduce that envelope: conforming MCP clients only invoke advertised tools,
// so the difference is not observable in practice. The "Unknown tool" branch
// below therefore only guards direct/internal callers of Dispatch (e.g. unit
// tests); the wired server never reaches it. Phase 6 MCP E2E should confirm the
// -32602 wire behavior. See TestServer_UnknownTool_WireBehavior for the pin.
func Dispatch(ctx context.Context, name string, args json.RawMessage, openDB DBFactory) *gomcp.CallToolResult {
	result, err := dispatch(ctx, name, args, openDB)
	if err != nil {
		return &gomcp.CallToolResult{
			Content: []gomcp.Content{&gomcp.TextContent{Text: HandleError(err)}},
			IsError: true,
		}
	}
	return result
}

func dispatch(ctx context.Context, name string, args json.RawMessage, openDB DBFactory) (*gomcp.CallToolResult, error) {
	switch name {
	case "search":
		params, err := ParseSearchInput(args)
		if err != nil {
			return nil, err
		}
		database, err := openDB()
		if err != nil {
			return nil, err
		}
		defer database.Close()

		results, err := HandleSearch(ctx, params, database)
		if err != nil {
			return nil, err
		}
		// Ports JSON.stringify({ results }, null, 2). An empty slice must
		// serialize as [] (not null), so we ensure a non-nil slice.
		if results == nil {
			results = []SearchResult{}
		}
		payload, err := json.MarshalIndent(map[string]any{"results": results}, "", "  ")
		if err != nil {
			return nil, err
		}
		return &gomcp.CallToolResult{
			Content: []gomcp.Content{&gomcp.TextContent{Text: string(payload)}},
		}, nil

	case "fetch":
		params, err := ParseFetchInput(args)
		if err != nil {
			return nil, err
		}
		database, err := openDB()
		if err != nil {
			return nil, err
		}
		defer database.Close()

		result, err := HandleFetch(params, database)
		if err != nil {
			return nil, err
		}
		return &gomcp.CallToolResult{
			Content: []gomcp.Content{&gomcp.TextContent{Text: result}},
		}, nil
	}

	return nil, fmt.Errorf("Unknown tool: %s", name)
}

// NewServer builds the MCP server with the two tools registered. The tool
// handlers delegate to Dispatch, which opens a DB per call via openDB. Ports the
// server construction + setRequestHandler wiring in src/mcp/server.ts.
func NewServer(openDB DBFactory) *gomcp.Server {
	server := gomcp.NewServer(&gomcp.Implementation{
		Name:    serverName,
		Version: serverVersion,
	}, nil)

	handler := func(ctx context.Context, req *gomcp.CallToolRequest) (*gomcp.CallToolResult, error) {
		return Dispatch(ctx, req.Params.Name, req.Params.Arguments, openDB), nil
	}

	server.AddTool(SearchTool(), handler)
	server.AddTool(FetchTool(), handler)
	return server
}

// NewProductionServer wires NewServer to the real configured database.
func NewProductionServer() *gomcp.Server {
	return NewServer(openProductionDB)
}
