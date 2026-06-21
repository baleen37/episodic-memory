#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW_FILE="$REPO_ROOT/.github/workflows/update-versions.yml"
ON_RELEASE_WORKFLOW_FILE="$REPO_ROOT/.github/workflows/on-release.yml"
MARKETPLACE_FILE="$REPO_ROOT/.claude-plugin/marketplace.json"
CLAUDE_PLUGIN_FILE="$REPO_ROOT/.claude-plugin/plugin.json"
CODEX_PLUGIN_FILE="$REPO_ROOT/.codex-plugin/plugin.json"
CODEX_MARKETPLACE_FILE="$REPO_ROOT/.agents/plugins/marketplace.json"
COPIED_PLUGIN_DIR="$REPO_ROOT/plugins/memmem"
PACKAGE_FILE="$REPO_ROOT/package.json"
DISPATCH_ACTION_SHA="12f7f29617c0083c78affd8c1e286e0a093fb0f9"

fail() {
  echo "FAIL: $1"
  exit 1
}

assert_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -Fq -- "$needle" "$file"; then
    fail "expected '$needle' in $file"
  fi
}

assert_not_contains() {
  local file="$1"
  local needle="$2"
  if grep -Fq -- "$needle" "$file"; then
    fail "did not expect '$needle' in $file"
  fi
}

if [[ ! -f "$WORKFLOW_FILE" ]]; then
  fail "workflow file not found: $WORKFLOW_FILE"
fi

if [[ ! -f "$ON_RELEASE_WORKFLOW_FILE" ]]; then
  fail "workflow file not found: $ON_RELEASE_WORKFLOW_FILE"
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

if [[ ! -f "$CODEX_MARKETPLACE_FILE" ]]; then
  fail "Codex marketplace file not found: $CODEX_MARKETPLACE_FILE"
fi

jq empty "$MARKETPLACE_FILE" || fail "invalid JSON: $MARKETPLACE_FILE"
jq empty "$CLAUDE_PLUGIN_FILE" || fail "invalid JSON: $CLAUDE_PLUGIN_FILE"
jq empty "$CODEX_PLUGIN_FILE" || fail "invalid JSON: $CODEX_PLUGIN_FILE"
jq empty "$CODEX_MARKETPLACE_FILE" || fail "invalid JSON: $CODEX_MARKETPLACE_FILE"

bash "$SCRIPT_DIR/verify-runtime-compatibility.test.sh" >/dev/null

package_version="$(jq -r '.version' "$PACKAGE_FILE")"
package_description="$(jq -r '.description' "$PACKAGE_FILE")"
package_repository="$(jq -r '.repository.url // .repository' "$PACKAGE_FILE")"
package_license="$(jq -r '.license' "$PACKAGE_FILE")"
package_keywords="$(jq -c '.keywords' "$PACKAGE_FILE")"
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

if [[ "$package_description" == "null" || -z "$package_description" ]]; then
  fail "package.json description must be set"
fi

if [[ "$package_repository" != "https://github.com/baleen37/memmem" ]]; then
  fail "package.json repository must be https://github.com/baleen37/memmem"
fi

if [[ "$package_license" != "MIT" ]]; then
  fail "package.json license must be MIT"
fi

if [[ "$package_keywords" != '["memory","transcripts","search","codex","claude"]' ]]; then
  fail "package.json keywords must match runtime plugin discovery tags"
fi

claude_description="$(jq -r '.description' "$CLAUDE_PLUGIN_FILE")"
codex_description="$(jq -r '.description' "$CODEX_PLUGIN_FILE")"
marketplace_description="$(jq -r '.plugins[0].description' "$MARKETPLACE_FILE")"
codex_repository="$(jq -r '.repository' "$CODEX_PLUGIN_FILE")"
codex_license="$(jq -r '.license' "$CODEX_PLUGIN_FILE")"
codex_keywords="$(jq -c '.keywords' "$CODEX_PLUGIN_FILE")"

if [[ "$package_description" != "$claude_description" ]]; then
  fail "package.json description does not match .claude-plugin/plugin.json"
fi

if [[ "$package_description" != "$codex_description" ]]; then
  fail "package.json description does not match .codex-plugin/plugin.json"
fi

if [[ "$package_description" != "$marketplace_description" ]]; then
  fail "package.json description does not match .claude-plugin/marketplace.json"
fi

if [[ "$package_repository" != "$codex_repository" ]]; then
  fail "package.json repository does not match .codex-plugin/plugin.json"
fi

if [[ "$package_license" != "$codex_license" ]]; then
  fail "package.json license does not match .codex-plugin/plugin.json"
fi

if [[ "$package_keywords" != "$codex_keywords" ]]; then
  fail "package.json keywords do not match .codex-plugin/plugin.json"
fi

if [[ "$(jq -r '.interface | type' "$CODEX_PLUGIN_FILE")" != "object" ]]; then
  fail ".codex-plugin/plugin.json interface must be an object"
fi

if [[ "$(jq -r 'has("mcpServers")' "$CODEX_PLUGIN_FILE")" != "true" ]]; then
  fail ".codex-plugin/plugin.json must preserve mcpServers"
fi

if [[ "$(jq -r '.plugins[0].source.path' "$CODEX_MARKETPLACE_FILE")" != "./plugins/memmem" ]]; then
  fail ".agents/plugins/marketplace.json must point Codex at ./plugins/memmem"
fi

if [[ ! -f "$COPIED_PLUGIN_DIR/.codex-plugin/plugin.json" ]]; then
  fail "copied plugin view must include .codex-plugin/plugin.json"
fi

if [[ ! -f "$COPIED_PLUGIN_DIR/.claude-plugin/plugin.json" ]]; then
  fail "copied plugin view must include .claude-plugin/plugin.json"
fi

if [[ ! -f "$COPIED_PLUGIN_DIR/.mcp.json" ]]; then
  fail "copied plugin view must include .mcp.json"
fi

for mcp_file in "$REPO_ROOT/.mcp.json" "$COPIED_PLUGIN_DIR/.mcp.json"; do
  if [[ "$(jq -r '.mcpServers.memmem.cwd // empty' "$mcp_file")" != "." ]]; then
    fail "$mcp_file memmem server must set cwd to plugin root for Codex"
  fi

  if [[ "$(jq -r '.mcpServers.memmem.command' "$mcp_file")" != "./bin/memmem" ]]; then
    fail "$mcp_file memmem server must use a Codex-compatible relative command"
  fi

  if grep -Fq 'CLAUDE_PLUGIN_ROOT' "$mcp_file"; then
    fail "$mcp_file must not rely on Claude-only CLAUDE_PLUGIN_ROOT expansion"
  fi
done

assert_contains "$WORKFLOW_FILE" "schedule:"
assert_contains "$WORKFLOW_FILE" "- cron: '0 * * * *'"
assert_contains "$WORKFLOW_FILE" "workflow_dispatch:"
assert_contains "$WORKFLOW_FILE" "repository_dispatch:"
assert_contains "$WORKFLOW_FILE" "types:"
assert_contains "$WORKFLOW_FILE" "- update_versions"
assert_contains "$WORKFLOW_FILE" "runs-on: ubuntu-latest"
assert_contains "$WORKFLOW_FILE" "- name: Checkout repository"
assert_contains "$WORKFLOW_FILE" "uses: actions/checkout@v4"
assert_contains "$WORKFLOW_FILE" "- name: Run update action"
assert_contains "$WORKFLOW_FILE" "uses: baleen37/baleen-marketplace/.github/actions/update-versions@"
assert_contains "$WORKFLOW_FILE" "marketplace-json: .claude-plugin/marketplace.json"
assert_contains "$WORKFLOW_FILE" "- name: Align standalone plugin metadata"
assert_contains "$WORKFLOW_FILE" ".claude-plugin/plugin.json"
assert_contains "$WORKFLOW_FILE" ".codex-plugin/plugin.json"
assert_contains "$WORKFLOW_FILE" "- name: Verify standalone plugin metadata"
assert_contains "$WORKFLOW_FILE" "git push"
assert_contains "$WORKFLOW_FILE" "permissions:"
assert_contains "$WORKFLOW_FILE" "contents: write"

assert_contains "$ON_RELEASE_WORKFLOW_FILE" "release:"
assert_contains "$ON_RELEASE_WORKFLOW_FILE" "types: [published]"
assert_contains "$ON_RELEASE_WORKFLOW_FILE" "uses: baleen37/baleen-marketplace/.github/actions/dispatch-marketplace-update@$DISPATCH_ACTION_SHA"
assert_contains "$ON_RELEASE_WORKFLOW_FILE" "github-token: \${{ secrets.BALEEN_MARKETPLACE_DISPATCH_TOKEN }}"
assert_contains "$ON_RELEASE_WORKFLOW_FILE" "event-type: update_versions"
assert_contains "$ON_RELEASE_WORKFLOW_FILE" "plugin: memmem"
assert_not_contains "$ON_RELEASE_WORKFLOW_FILE" "dispatch-marketplace-update@main"

echo "PASS: update-versions and on-release workflow wiring is valid"
