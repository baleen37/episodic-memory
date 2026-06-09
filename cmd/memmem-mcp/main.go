// Command memmem-mcp is the MCP server entrypoint for the Go port of memmem.
//
// Ports src/mcp/ (server.ts, handlers.ts, schemas.ts, tools.ts). Exposes only
// the search and read tools.
//
// TODO(phase2+): wire up the MCP server and search/read handlers.
package main

import "fmt"

func main() {
	fmt.Println("memmem-mcp (Go port): not yet implemented")
}
