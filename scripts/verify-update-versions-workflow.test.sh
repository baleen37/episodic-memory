#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW_FILE="$REPO_ROOT/.github/workflows/update-versions.yml"

fail() {
  echo "FAIL: $1"
  exit 1
}

assert_contains() {
  local needle="$1"
  if ! grep -Fq -- "$needle" "$WORKFLOW_FILE"; then
    fail "expected '$needle' in $WORKFLOW_FILE"
  fi
}

if [[ ! -f "$WORKFLOW_FILE" ]]; then
  fail "workflow file not found: $WORKFLOW_FILE"
fi

assert_contains "schedule:"
assert_contains "- cron: '0 * * * *'"
assert_contains "workflow_dispatch:"
assert_contains "repository_dispatch:"
assert_contains "types:"
assert_contains "- update_versions"
assert_contains "uses: baleen37/baleen-marketplace/.github/workflows/reusable-update-versions.yml@main"
assert_contains "permissions:"
assert_contains "contents: write"

echo "PASS: update-versions workflow wiring is valid"
