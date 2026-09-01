#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PACKAGE_FILE="$REPO_ROOT/package.json"
CLAUDE_PLUGIN_FILE="$REPO_ROOT/.claude-plugin/plugin.json"
CODEX_PLUGIN_FILE="$REPO_ROOT/.codex-plugin/plugin.json"
ROOT_MCP_FILE="$REPO_ROOT/.mcp.json"
ROOT_MCP_LAUNCHER_FILE="$REPO_ROOT/src/cli/mcp.ts"

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

for file in \
  "$PACKAGE_FILE" \
  "$CLAUDE_PLUGIN_FILE" \
  "$CODEX_PLUGIN_FILE" \
  "$ROOT_MCP_FILE"; do
  assert_json_file "$file"
done

package_version="$(jq -r '.version' "$PACKAGE_FILE")"
package_name="$(jq -r '.name' "$PACKAGE_FILE")"
plugin_name="${package_name##*/}"
package_bin_name="$(jq -r '.bin | keys[0]' "$PACKAGE_FILE")"
package_bin_path="$(jq -r --arg name "$package_bin_name" '.bin[$name]' "$PACKAGE_FILE")"
package_description="$(jq -r '.description' "$PACKAGE_FILE")"
package_repository="$(jq -r '.repository.url // .repository' "$PACKAGE_FILE")"
package_homepage="$(jq -r '.homepage // .repository.url // .repository' "$PACKAGE_FILE")"
package_license="$(jq -r '.license' "$PACKAGE_FILE")"
package_keywords="$(jq -c '.keywords' "$PACKAGE_FILE")"

assert_equals "$package_version" "$(jq -r '.version' "$CLAUDE_PLUGIN_FILE")" "claude manifest version drift"
assert_equals "$plugin_name" "$(jq -r '.name' "$CLAUDE_PLUGIN_FILE")" "claude manifest name drift"
assert_equals "$package_description" "$(jq -r '.description' "$CLAUDE_PLUGIN_FILE")" "claude manifest description drift"
assert_equals "$package_repository" "$(jq -r '.repository' "$CLAUDE_PLUGIN_FILE")" "claude manifest repository drift"
assert_equals "$package_homepage" "$(jq -r '.homepage' "$CLAUDE_PLUGIN_FILE")" "claude manifest homepage drift"
assert_equals "$package_license" "$(jq -r '.license' "$CLAUDE_PLUGIN_FILE")" "claude manifest license drift"
assert_equals "$package_keywords" "$(jq -c '.keywords' "$CLAUDE_PLUGIN_FILE")" "claude manifest keywords drift"

assert_equals "$package_version" "$(jq -r '.version' "$CODEX_PLUGIN_FILE")" "codex manifest version drift"
assert_equals "$plugin_name" "$(jq -r '.name' "$CODEX_PLUGIN_FILE")" "codex manifest name drift"
assert_equals "$package_description" "$(jq -r '.description' "$CODEX_PLUGIN_FILE")" "codex manifest description drift"
assert_equals "$package_repository" "$(jq -r '.repository' "$CODEX_PLUGIN_FILE")" "codex manifest repository drift"
assert_equals "$package_homepage" "$(jq -r '.homepage' "$CODEX_PLUGIN_FILE")" "codex manifest homepage drift"
assert_equals "$package_license" "$(jq -r '.license' "$CODEX_PLUGIN_FILE")" "codex manifest license drift"
assert_equals "$package_keywords" "$(jq -c '.keywords' "$CODEX_PLUGIN_FILE")" "codex manifest keywords drift"

assert_equals "$plugin_name" "$package_bin_name" "package bin name drift"
assert_equals "bin/$plugin_name" "$package_bin_path" "package bin path drift"
assert_equals "$plugin_name" "$(jq -r '.mcpServers | keys[0]' "$ROOT_MCP_FILE")" "root MCP server name drift"
assert_equals "true" "$(jq -r --arg name "$plugin_name" '.mcpServers[$name].args[1] | contains("/bin/" + $name)' "$ROOT_MCP_FILE")" "root MCP executable drift"

assert_equals "object" "$(jq -r '.interface | type' "$CODEX_PLUGIN_FILE")" "codex manifest interface"
assert_equals "true" "$(jq -r 'has("mcpServers")' "$CODEX_PLUGIN_FILE")" "codex manifest mcpServers presence"
assert_path_starts_dot_slash "$(jq -r '.skills' "$CODEX_PLUGIN_FILE")" "codex manifest skills path"
assert_path_starts_dot_slash "$(jq -r '.mcpServers' "$CODEX_PLUGIN_FILE")" "codex manifest mcpServers path"

assert_equals "true" "$(grep -F 'process.env.PLUGIN_ROOT' "$ROOT_MCP_LAUNCHER_FILE" >/dev/null && echo true || echo false)" "root MCP launcher PLUGIN_ROOT support"

if jq -e 'has("interface")' "$CLAUDE_PLUGIN_FILE" >/dev/null; then
  fail "claude manifest must not include Codex-only interface field"
fi

echo "PASS: runtime compatibility manifests are valid"
