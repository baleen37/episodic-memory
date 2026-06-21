#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v claude >/dev/null 2>&1; then
  echo "FAIL: claude CLI is required for local plugin validation"
  exit 1
fi

echo "== Claude plugin validation =="
claude plugin validate . --strict

echo "== Runtime manifest compatibility =="
bash scripts/verify-runtime-compatibility.test.sh

echo "== TypeScript typecheck =="
bun run typecheck

echo "== Focused MCP and hook tests =="
bun test hooks/hooks.test.ts src/mcp/server.test.ts src/mcp/server.lifecycle.test.ts

echo "== Build =="
bun run build

echo "== CLI smoke =="
bin/memmem --help >/dev/null

echo "PASS: runtime compatibility preflight completed"
