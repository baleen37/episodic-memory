package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	gomcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// These tests port the tool-definition assertions implied by src/mcp/tools.ts
// and the ListTools expectations in src/mcp/server.test.ts. CGO-free.

func TestAllTools_ReturnsTwoTools(t *testing.T) {
	tools := AllTools()
	if len(tools) != 2 {
		t.Fatalf("expected 2 tools, got %d", len(tools))
	}
	if tools[0].Name != "search" || tools[1].Name != "fetch" {
		t.Fatalf("unexpected tool names: %q, %q", tools[0].Name, tools[1].Name)
	}
}

func TestSearchTool_Annotations(t *testing.T) {
	a := SearchTool().Annotations
	if a == nil {
		t.Fatal("nil annotations")
	}
	if a.Title != "Search Memory Records" {
		t.Fatalf("title %q", a.Title)
	}
	if !a.ReadOnlyHint || a.DestructiveHint == nil || *a.DestructiveHint {
		t.Fatal("readOnlyHint:true destructiveHint:false expected")
	}
	if !a.IdempotentHint || a.OpenWorldHint == nil || *a.OpenWorldHint {
		t.Fatal("idempotentHint:true openWorldHint:false expected")
	}
}

func TestFetchTool_Annotations(t *testing.T) {
	a := FetchTool().Annotations
	if a.Title != "Fetch Memory Source Transcript" {
		t.Fatalf("title %q", a.Title)
	}
	if !a.ReadOnlyHint || !a.IdempotentHint {
		t.Fatal("readOnly+idempotent hints expected")
	}
}

// schemaMap unmarshals the raw JSON schema for inspection.
func schemaMap(t *testing.T, raw any) map[string]any {
	t.Helper()
	b, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestSearchTool_SchemaBounds(t *testing.T) {
	m := schemaMap(t, SearchTool().InputSchema)
	if m["additionalProperties"] != false {
		t.Fatalf("additionalProperties should be false, got %v", m["additionalProperties"])
	}
	req, _ := m["required"].([]any)
	if len(req) != 1 || req[0] != "query" {
		t.Fatalf("required should be [query], got %v", m["required"])
	}
	props := m["properties"].(map[string]any)
	limit := props["limit"].(map[string]any)
	if limit["minimum"].(float64) != 1 || limit["maximum"].(float64) != 50 || limit["default"].(float64) != 10 {
		t.Fatalf("limit bounds/default wrong: %v", limit)
	}
	// query union present.
	query := props["query"].(map[string]any)
	if _, ok := query["anyOf"]; !ok {
		t.Fatal("query should be an anyOf union")
	}
}

func TestFetchTool_SchemaBounds(t *testing.T) {
	m := schemaMap(t, FetchTool().InputSchema)
	if m["additionalProperties"] != false {
		t.Fatalf("additionalProperties should be false")
	}
	req, _ := m["required"].([]any)
	if len(req) != 1 || req[0] != "id" {
		t.Fatalf("required should be [id], got %v", m["required"])
	}
}

func TestNewServer_Constructs(t *testing.T) {
	// Smoke: building the server with an in-memory factory must not panic and
	// must register the tools. Server name/version come from the Implementation.
	factory, _ := memDBFactory(t)
	srv := NewServer(factory)
	if srv == nil {
		t.Fatal("nil server")
	}
}

// connectInMemory wires a client to NewServer over the go-sdk in-memory
// transport (no stdio/process scaffolding), returning the connected client
// session. It exercises the REAL server wiring, including the go-sdk's
// protocol-layer tool routing.
func connectInMemory(t *testing.T, factory DBFactory) *gomcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	serverT, clientT := gomcp.NewInMemoryTransports()

	srv := NewServer(factory)
	ss, err := srv.Connect(ctx, serverT, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	t.Cleanup(func() { ss.Close() })

	client := gomcp.NewClient(&gomcp.Implementation{Name: "test-client", Version: "0.0.0"}, nil)
	cs, err := client.Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

// TestServer_ListTools_WireBehavior pins the real ListTools wire response: the
// two advertised tools come back over the protocol.
func TestServer_ListTools_WireBehavior(t *testing.T) {
	factory, _ := memDBFactory(t)
	cs := connectInMemory(t, factory)

	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(res.Tools) != 2 {
		t.Fatalf("expected 2 tools over the wire, got %d", len(res.Tools))
	}
	names := map[string]bool{}
	for _, tool := range res.Tools {
		names[tool.Name] = true
	}
	if !names["search"] || !names["fetch"] {
		t.Fatalf("expected search+fetch tools, got %v", names)
	}
}

// TestServer_UnknownTool_WireBehavior pins the DIVERGENCE: over the real go-sdk
// wiring, an unadvertised tool name is rejected at the protocol layer as a
// JSON-RPC error (the Dispatch "Unknown tool" envelope is never produced). The
// TS server would instead return an {isError:true} content envelope; conforming
// MCP clients never call unadvertised tools, so this is not observable in
// practice. Phase 6 MCP E2E should confirm this -32602 behavior.
func TestServer_UnknownTool_WireBehavior(t *testing.T) {
	factory, _ := memDBFactory(t)
	cs := connectInMemory(t, factory)

	res, err := cs.CallTool(context.Background(), &gomcp.CallToolParams{
		Name:      "unknown_tool",
		Arguments: map[string]any{},
	})
	if err == nil {
		t.Fatalf("expected a protocol-layer JSON-RPC error for an unknown tool, got result %+v", res)
	}
	// The go-sdk surfaces the unknown tool as an error mentioning the tool name;
	// it must NOT arrive as a successful {isError:true} content envelope.
	if !strings.Contains(err.Error(), "unknown_tool") {
		t.Fatalf("error should reference the unknown tool name, got %q", err.Error())
	}
}
