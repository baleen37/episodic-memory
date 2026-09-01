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
VALIDATION_DIR="$(mktemp -d "${TMPDIR:-/tmp}/episodic-memory-plugin-validation.XXXXXX")"
cleanup_validation_dir() {
  rm -rf "$VALIDATION_DIR"
}
trap cleanup_validation_dir EXIT

# CLAUDE.md is repository maintainer guidance. Claude's plugin validator warns
# that a plugin-root CLAUDE.md is not loaded as project context, so validate a
# payload copy that contains the plugin surface without that repository file.
tar -C "$REPO_ROOT" \
  --exclude='./CLAUDE.md' \
  --exclude='./.git' \
  --exclude='./.worktrees' \
  --exclude='./node_modules' \
  --exclude='./.verify' \
  -cf - . | tar -C "$VALIDATION_DIR" -xf -
claude plugin validate "$VALIDATION_DIR" --strict

echo "== Runtime manifest compatibility =="
bash scripts/verify-runtime-compatibility.test.sh

echo "== TypeScript typecheck =="
bun run typecheck

echo "== Focused MCP and hook tests =="
bun test hooks/hooks.test.ts src/mcp/server.test.ts src/mcp/server.lifecycle.test.ts

echo "== Build =="
bun run build

echo "== CLI smoke =="
bin/episodic-memory --help >/dev/null

echo "PASS: runtime compatibility preflight completed"
