#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PACKAGE_FILE="$REPO_ROOT/package.json"
CLAUDE_PLUGIN_FILE="$REPO_ROOT/.claude-plugin/plugin.json"
CLAUDE_MARKETPLACE_FILE="$REPO_ROOT/.claude-plugin/marketplace.json"
CODEX_PLUGIN_FILE="$REPO_ROOT/.codex-plugin/plugin.json"
CODEX_MARKETPLACE_FILE="$REPO_ROOT/.agents/plugins/marketplace.json"

fail() {
  echo "FAIL: $1"
  exit 1
}

assert_json_file() {
  local file="$1"
  [[ -f "$file" ]] || fail "file not found: $file"
  jq empty "$file" >/dev/null || fail "invalid JSON: $file"
}

assert_equals() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  [[ "$expected" == "$actual" ]] || fail "$message: expected '$expected', got '$actual'"
}

assert_path_starts_dot_slash() {
  local path_value="$1"
  local message="$2"
  [[ "$path_value" == ./* ]] || fail "$message must start with ./, got '$path_value'"
}

for file in "$PACKAGE_FILE" "$CLAUDE_PLUGIN_FILE" "$CLAUDE_MARKETPLACE_FILE" "$CODEX_PLUGIN_FILE" "$CODEX_MARKETPLACE_FILE"; do
  assert_json_file "$file"
done

package_version="$(jq -r '.version' "$PACKAGE_FILE")"
package_description="$(jq -r '.description' "$PACKAGE_FILE")"
package_repository="$(jq -r '.repository.url // .repository' "$PACKAGE_FILE")"
package_homepage="$(jq -r '.homepage // .repository.url // .repository' "$PACKAGE_FILE")"
package_license="$(jq -r '.license' "$PACKAGE_FILE")"
package_keywords="$(jq -c '.keywords' "$PACKAGE_FILE")"

assert_equals "$package_version" "$(jq -r '.version' "$CLAUDE_PLUGIN_FILE")" "claude manifest version drift"
assert_equals "$package_description" "$(jq -r '.description' "$CLAUDE_PLUGIN_FILE")" "claude manifest description drift"
assert_equals "$package_repository" "$(jq -r '.repository' "$CLAUDE_PLUGIN_FILE")" "claude manifest repository drift"
assert_equals "$package_homepage" "$(jq -r '.homepage' "$CLAUDE_PLUGIN_FILE")" "claude manifest homepage drift"
assert_equals "$package_license" "$(jq -r '.license' "$CLAUDE_PLUGIN_FILE")" "claude manifest license drift"
assert_equals "$package_keywords" "$(jq -c '.keywords' "$CLAUDE_PLUGIN_FILE")" "claude manifest keywords drift"
assert_equals "$package_version" "$(jq -r '.plugins[0].version' "$CLAUDE_MARKETPLACE_FILE")" "claude marketplace version drift"
assert_equals "$package_description" "$(jq -r '.plugins[0].description' "$CLAUDE_MARKETPLACE_FILE")" "claude marketplace description drift"

assert_equals "$package_version" "$(jq -r '.version' "$CODEX_PLUGIN_FILE")" "codex manifest version drift"
assert_equals "$package_description" "$(jq -r '.description' "$CODEX_PLUGIN_FILE")" "codex manifest description drift"
assert_equals "$package_repository" "$(jq -r '.repository' "$CODEX_PLUGIN_FILE")" "codex manifest repository drift"
assert_equals "$package_homepage" "$(jq -r '.homepage' "$CODEX_PLUGIN_FILE")" "codex manifest homepage drift"
assert_equals "$package_license" "$(jq -r '.license' "$CODEX_PLUGIN_FILE")" "codex manifest license drift"
assert_equals "$package_keywords" "$(jq -c '.keywords' "$CODEX_PLUGIN_FILE")" "codex manifest keywords drift"

assert_equals "object" "$(jq -r '.interface | type' "$CODEX_PLUGIN_FILE")" "codex manifest interface"
assert_equals "true" "$(jq -r 'has("mcpServers")' "$CODEX_PLUGIN_FILE")" "codex manifest mcpServers presence"
assert_path_starts_dot_slash "$(jq -r '.skills' "$CODEX_PLUGIN_FILE")" "codex manifest skills path"
assert_path_starts_dot_slash "$(jq -r '.mcpServers' "$CODEX_PLUGIN_FILE")" "codex manifest mcpServers path"

assert_equals "memmem" "$(jq -r '.plugins[0].name' "$CODEX_MARKETPLACE_FILE")" "codex marketplace plugin name"
assert_equals "local" "$(jq -r '.plugins[0].source.source' "$CODEX_MARKETPLACE_FILE")" "codex marketplace source type"
assert_equals "./plugins/memmem" "$(jq -r '.plugins[0].source.path' "$CODEX_MARKETPLACE_FILE")" "codex marketplace source path"
assert_equals "AVAILABLE" "$(jq -r '.plugins[0].policy.installation' "$CODEX_MARKETPLACE_FILE")" "codex marketplace installation policy"
assert_equals "ON_INSTALL" "$(jq -r '.plugins[0].policy.authentication' "$CODEX_MARKETPLACE_FILE")" "codex marketplace authentication policy"

if jq -e 'has("interface")' "$CLAUDE_PLUGIN_FILE" >/dev/null; then
  fail "claude manifest must not include Codex-only interface field"
fi

echo "PASS: runtime compatibility manifests are valid"
