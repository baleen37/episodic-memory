#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PACKAGE_FILE="$REPO_ROOT/package.json"
CLAUDE_PLUGIN_FILE="$REPO_ROOT/.claude-plugin/plugin.json"
CLAUDE_MARKETPLACE_FILE="$REPO_ROOT/.claude-plugin/marketplace.json"
CODEX_PLUGIN_FILE="$REPO_ROOT/.codex-plugin/plugin.json"
CODEX_MARKETPLACE_FILE="$REPO_ROOT/.agents/plugins/marketplace.json"
ROOT_MCP_FILE="$REPO_ROOT/.mcp.json"
COPIED_PLUGIN_DIR="$REPO_ROOT/plugins/memmem"
COPIED_CLAUDE_PLUGIN_FILE="$COPIED_PLUGIN_DIR/.claude-plugin/plugin.json"
COPIED_CODEX_PLUGIN_FILE="$COPIED_PLUGIN_DIR/.codex-plugin/plugin.json"
COPIED_MCP_FILE="$COPIED_PLUGIN_DIR/.mcp.json"
ROOT_PACKAGE_LOCK_FILE="$REPO_ROOT/package-lock.json"
COPIED_PACKAGE_LOCK_FILE="$COPIED_PLUGIN_DIR/package-lock.json"
ROOT_BUN_LOCK_FILE="$REPO_ROOT/bun.lock"
COPIED_BUN_LOCK_FILE="$COPIED_PLUGIN_DIR/bun.lock"
ROOT_TSCONFIG_FILE="$REPO_ROOT/tsconfig.json"
COPIED_TSCONFIG_FILE="$COPIED_PLUGIN_DIR/tsconfig.json"
ROOT_README_FILE="$REPO_ROOT/README.md"
COPIED_README_FILE="$COPIED_PLUGIN_DIR/README.md"
ROOT_MCP_LAUNCHER_FILE="$REPO_ROOT/src/cli/mcp.ts"
COPIED_MCP_LAUNCHER_FILE="$COPIED_PLUGIN_DIR/src/cli/mcp.ts"
ROOT_AGENTS_DIR="$REPO_ROOT/agents"
COPIED_AGENTS_DIR="$COPIED_PLUGIN_DIR/agents"
ROOT_BIN_DIR="$REPO_ROOT/bin"
COPIED_BIN_DIR="$COPIED_PLUGIN_DIR/bin"
ROOT_DIST_DIR="$REPO_ROOT/dist"
COPIED_DIST_DIR="$COPIED_PLUGIN_DIR/dist"
ROOT_HOOKS_DIR="$REPO_ROOT/hooks"
COPIED_HOOKS_DIR="$COPIED_PLUGIN_DIR/hooks"
ROOT_SCRIPTS_DIR="$REPO_ROOT/scripts"
COPIED_SCRIPTS_DIR="$COPIED_PLUGIN_DIR/scripts"
ROOT_SKILLS_DIR="$REPO_ROOT/skills"
COPIED_SKILLS_DIR="$COPIED_PLUGIN_DIR/skills"
ROOT_SRC_DIR="$REPO_ROOT/src"
COPIED_SRC_DIR="$COPIED_PLUGIN_DIR/src"

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

assert_same_file_contents() {
  local expected_file="$1"
  local actual_file="$2"
  local message="$3"
  [[ -f "$expected_file" ]] || fail "file not found: $expected_file"
  [[ -f "$actual_file" ]] || fail "file not found: $actual_file"
  cmp -s "$expected_file" "$actual_file" || fail "$message"
}

assert_same_tree_contents() {
  local expected_dir="$1"
  local actual_dir="$2"
  local message="$3"
  [[ -d "$expected_dir" ]] || fail "directory not found: $expected_dir"
  [[ -d "$actual_dir" ]] || fail "directory not found: $actual_dir"
  diff -qr "$expected_dir" "$actual_dir" >/dev/null || fail "$message"
}

for file in \
  "$PACKAGE_FILE" \
  "$CLAUDE_PLUGIN_FILE" \
  "$CLAUDE_MARKETPLACE_FILE" \
  "$CODEX_PLUGIN_FILE" \
  "$CODEX_MARKETPLACE_FILE" \
  "$ROOT_MCP_FILE" \
  "$COPIED_CLAUDE_PLUGIN_FILE" \
  "$COPIED_CODEX_PLUGIN_FILE" \
  "$COPIED_MCP_FILE"; do
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

assert_same_file_contents "$CLAUDE_PLUGIN_FILE" "$COPIED_CLAUDE_PLUGIN_FILE" "copied Claude manifest drift"
assert_same_file_contents "$CODEX_PLUGIN_FILE" "$COPIED_CODEX_PLUGIN_FILE" "copied Codex manifest drift"
assert_same_file_contents "$ROOT_MCP_FILE" "$COPIED_MCP_FILE" "copied MCP config drift"
assert_same_file_contents "$PACKAGE_FILE" "$COPIED_PLUGIN_DIR/package.json" "copied package.json drift"
assert_same_file_contents "$ROOT_PACKAGE_LOCK_FILE" "$COPIED_PACKAGE_LOCK_FILE" "copied package-lock.json drift"
assert_same_file_contents "$ROOT_BUN_LOCK_FILE" "$COPIED_BUN_LOCK_FILE" "copied bun.lock drift"
assert_same_file_contents "$ROOT_TSCONFIG_FILE" "$COPIED_TSCONFIG_FILE" "copied tsconfig.json drift"
assert_same_file_contents "$ROOT_README_FILE" "$COPIED_README_FILE" "copied README drift"
assert_same_file_contents "$ROOT_MCP_LAUNCHER_FILE" "$COPIED_MCP_LAUNCHER_FILE" "copied MCP launcher drift"
assert_same_tree_contents "$ROOT_AGENTS_DIR" "$COPIED_AGENTS_DIR" "copied agents payload drift"
assert_same_tree_contents "$ROOT_BIN_DIR" "$COPIED_BIN_DIR" "copied bin payload drift"
assert_same_tree_contents "$ROOT_DIST_DIR" "$COPIED_DIST_DIR" "copied dist payload drift"
assert_same_tree_contents "$ROOT_HOOKS_DIR" "$COPIED_HOOKS_DIR" "copied hooks payload drift"
assert_same_tree_contents "$ROOT_SCRIPTS_DIR" "$COPIED_SCRIPTS_DIR" "copied scripts payload drift"
assert_same_tree_contents "$ROOT_SKILLS_DIR" "$COPIED_SKILLS_DIR" "copied skills payload drift"
assert_same_tree_contents "$ROOT_SRC_DIR" "$COPIED_SRC_DIR" "copied src payload drift"

assert_equals "true" "$(grep -F 'process.env.PLUGIN_ROOT' "$ROOT_MCP_LAUNCHER_FILE" >/dev/null && echo true || echo false)" "root MCP launcher PLUGIN_ROOT support"
assert_equals "true" "$(grep -F 'process.env.PLUGIN_ROOT' "$COPIED_MCP_LAUNCHER_FILE" >/dev/null && echo true || echo false)" "copied MCP launcher PLUGIN_ROOT support"

if jq -e 'has("interface")' "$CLAUDE_PLUGIN_FILE" >/dev/null; then
  fail "claude manifest must not include Codex-only interface field"
fi

echo "PASS: runtime compatibility manifests are valid"
