#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW_FILE="$REPO_ROOT/.github/workflows/update-versions.yml"
MARKETPLACE_FILE="$REPO_ROOT/.claude-plugin/marketplace.json"
CLAUDE_PLUGIN_FILE="$REPO_ROOT/.claude-plugin/plugin.json"
CODEX_PLUGIN_FILE="$REPO_ROOT/.codex-plugin/plugin.json"
PACKAGE_FILE="$REPO_ROOT/package.json"

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

if [[ ! -f "$MARKETPLACE_FILE" ]]; then
  fail "marketplace file not found: $MARKETPLACE_FILE"
fi

if [[ ! -f "$CLAUDE_PLUGIN_FILE" ]]; then
  fail "Claude plugin manifest not found: $CLAUDE_PLUGIN_FILE"
fi

if [[ ! -f "$CODEX_PLUGIN_FILE" ]]; then
  fail "Codex plugin manifest not found: $CODEX_PLUGIN_FILE"
fi

jq empty "$MARKETPLACE_FILE" || fail "invalid JSON: $MARKETPLACE_FILE"
jq empty "$CLAUDE_PLUGIN_FILE" || fail "invalid JSON: $CLAUDE_PLUGIN_FILE"
jq empty "$CODEX_PLUGIN_FILE" || fail "invalid JSON: $CODEX_PLUGIN_FILE"

package_version="$(jq -r '.version' "$PACKAGE_FILE")"
claude_version="$(jq -r '.version' "$CLAUDE_PLUGIN_FILE")"
codex_version="$(jq -r '.version' "$CODEX_PLUGIN_FILE")"
marketplace_version="$(jq -r '.plugins[0].version' "$MARKETPLACE_FILE")"

if [[ "$package_version" != "$claude_version" ]]; then
  fail "package.json version ($package_version) does not match .claude-plugin/plugin.json ($claude_version)"
fi

if [[ "$package_version" != "$codex_version" ]]; then
  fail "package.json version ($package_version) does not match .codex-plugin/plugin.json ($codex_version)"
fi

if [[ "$package_version" != "$marketplace_version" ]]; then
  fail "package.json version ($package_version) does not match .claude-plugin/marketplace.json ($marketplace_version)"
fi

if [[ "$(jq -r '.interface | type' "$CODEX_PLUGIN_FILE")" != "object" ]]; then
  fail ".codex-plugin/plugin.json interface must be an object"
fi

if [[ "$(jq -r 'has("mcpServers")' "$CODEX_PLUGIN_FILE")" != "true" ]]; then
  fail ".codex-plugin/plugin.json must preserve mcpServers"
fi

assert_contains "schedule:"
assert_contains "- cron: '0 * * * *'"
assert_contains "workflow_dispatch:"
assert_contains "repository_dispatch:"
assert_contains "types:"
assert_contains "- update_versions"
assert_contains "runs-on: ubuntu-latest"
assert_contains "- name: Checkout repository"
assert_contains "uses: actions/checkout@v4"
assert_contains "- name: Run update action"
assert_contains "uses: baleen37/baleen-marketplace/.github/actions/update-versions@main"
assert_contains "marketplace-json: .claude-plugin/marketplace.json"
assert_contains "- name: Align standalone plugin metadata"
assert_contains ".claude-plugin/plugin.json"
assert_contains ".codex-plugin/plugin.json"
assert_contains "- name: Verify standalone plugin metadata"
assert_contains "git push"
assert_contains "permissions:"
assert_contains "contents: write"

echo "PASS: update-versions workflow wiring is valid"
