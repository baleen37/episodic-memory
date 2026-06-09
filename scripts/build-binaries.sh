#!/usr/bin/env bash
# Build the Go binaries into bin/. On a local dev host this "just works":
#   1. fetch gitignored native assets if missing (ORT dylib, libtokenizers.a, tokenizer.json)
#   2. stage the go:embed runtime assets (ORT lib + tokenizer)
#   3. build the CLI and MCP server with the CGO static-link path for libtokenizers.a
# CI/goreleaser provisions assets per-platform and does not use fetch-dev-assets.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bash scripts/fetch-dev-assets.sh
bash scripts/stage-runtime-assets.sh

export CGO_ENABLED=1
export CGO_LDFLAGS="-L$ROOT/poc/lib"
go build -o bin/memmem ./cmd/memmem
go build -o bin/memmem-mcp ./cmd/memmem-mcp

echo "Built bin/memmem and bin/memmem-mcp"
