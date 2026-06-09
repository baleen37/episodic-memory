// Command memmem-mcp is the MCP server entrypoint for the Go port of memmem.
//
// Ports src/mcp/server.ts main(): log a banner to STDERR and serve the search
// and fetch tools over a stdio JSON-RPC transport. The tool definitions,
// validation, handlers, and dispatch live in internal/mcp.
package main

import (
	"context"
	"fmt"
	"os"

	appmcp "github.com/baleen37/memmem/internal/mcp"
	gomcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	// Ports console.error('Conversation Memory MCP server running via stdio').
	fmt.Fprintln(os.Stderr, "Conversation Memory MCP server running via stdio")

	server := appmcp.NewProductionServer()
	if err := server.Run(context.Background(), &gomcp.StdioTransport{}); err != nil {
		fmt.Fprintln(os.Stderr, "Server error:", err)
		os.Exit(1)
	}
}
