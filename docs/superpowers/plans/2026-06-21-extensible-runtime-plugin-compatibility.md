# Extensible Runtime Plugin Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden memmem's plugin packaging so Claude Code and Codex stay compatible today, while future runtimes such as Gemini can be added through adapter entries rather than duplicated plugin payloads.

**Architecture:** Keep runtime-specific manifests separate and preserve the shared runtime payload (`skills/`, `agents/`, `hooks/`, `.mcp.json`, `bin/`, `dist/`). Add adapter-oriented verification scripts that compare each runtime surface against `package.json` and runtime-specific schema rules. Keep heavyweight local smoke commands in an explicit preflight script so CI-safe checks do not require Claude or Codex binaries.

**Tech Stack:** Bash, jq, Bun, TypeScript, Claude Code plugin validator, Codex plugin manifest schema conventions, MCP stdio.

## Global Constraints

- Current target runtimes are Claude Code and Codex.
- Future runtimes must be added as adapter entries, manifest/check files, and docs sections without duplicating the common runtime payload.
- `package.json` is the source of truth for `version`, `description`, `repository`, `license`, and `keywords`.
- Runtime-specific fields must stay in runtime-specific manifests. Do not add Codex-only `interface` to `.claude-plugin/plugin.json`.
- `.mcp.json` stays stdio-only with `command: "./bin/memmem"`, `args: ["mcp"]`, and `cwd: "."`.
- Codex marketplace version is not a core update boundary; do not add package version duplication to `.agents/plugins/marketplace.json`.
- Claude validation uses `claude plugin validate . --strict` in local preflight.
- CI-safe checks must not require Claude or Codex CLI binaries.
- Do not implement Gemini support in this work; only make the structure easy to extend.

---

## File Structure

- Modify `package.json`: add missing package metadata, add `compat:check` and `compat:preflight` scripts.
- Modify `scripts/sync-plugin-versions.sh`: sync package metadata into Claude/Codex manifests and Claude marketplace.
- Create `scripts/verify-runtime-compatibility.test.sh`: CI-safe adapter-based drift and shape checks using Bash and jq.
- Create `scripts/preflight-runtime-compatibility.sh`: local full preflight that runs Claude validation, CI-safe checks, focused tests, build, and CLI smoke.
- Modify `scripts/verify-update-versions-workflow.test.sh`: delegate overlapping manifest checks to the new compatibility script and keep workflow-specific assertions in this file.
- Modify `scripts/README.md`: document runtime adapter model and local preflight.
- Modify `README.md`: document Claude/Codex install/update semantics at user level.
- Modify `src/cli/mcp.ts`: normalize plugin root environment names for Claude and Codex.
- Modify `hooks/hooks.test.ts`: pin plugin root environment normalization.
- Test existing `src/mcp/server.test.ts`, `src/mcp/server.lifecycle.test.ts`: keep MCP behavior and lifecycle checks passing.

---

### Task 1: Establish Package Metadata Source Of Truth

**Files:**
- Modify: `package.json`
- Modify: `scripts/sync-plugin-versions.sh`
- Modify: `scripts/verify-update-versions-workflow.test.sh`

**Interfaces:**
- Consumes: existing `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Produces: package metadata fields consumed by `scripts/verify-runtime-compatibility.test.sh`

- [ ] **Step 1: Write the failing package metadata assertions**

In `scripts/verify-update-versions-workflow.test.sh`, after `package_version=...`, add:

```bash
package_description="$(jq -r '.description' "$PACKAGE_FILE")"
package_repository="$(jq -r '.repository.url // .repository' "$PACKAGE_FILE")"
package_license="$(jq -r '.license' "$PACKAGE_FILE")"
package_keywords="$(jq -c '.keywords' "$PACKAGE_FILE")"

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
```

Then after the existing version comparisons, add:

```bash
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
```

- [ ] **Step 2: Run the workflow test and verify it fails**

Run:

```bash
bash scripts/verify-update-versions-workflow.test.sh
```

Expected: FAIL because `package.json` does not yet define `repository`, `license`, or `keywords`.

- [ ] **Step 3: Add package metadata**

Modify the top of `package.json` to include these fields after `description`:

```json
  "description": "Memmem - Conversation memory with semantic search across Claude Code and Codex sessions",
  "repository": {
    "type": "git",
    "url": "https://github.com/baleen37/memmem"
  },
  "homepage": "https://github.com/baleen37/memmem",
  "license": "MIT",
  "keywords": [
    "memory",
    "transcripts",
    "search",
    "codex",
    "claude"
  ],
```

Do not edit `package-lock.json` in this task. The lockfile is already stale versus `package.json`; this task only establishes manifest metadata.

- [ ] **Step 4: Expand metadata sync script**

Replace `scripts/sync-plugin-versions.sh` with:

```bash
#!/usr/bin/env bash
set -euo pipefail

# package.json is the source of truth for shared plugin metadata.
version="$(jq -r '.version' package.json)"
description="$(jq -r '.description' package.json)"
repository="$(jq -r '.repository.url // .repository' package.json)"
homepage="$(jq -r '.homepage // .repository.url // .repository' package.json)"
license="$(jq -r '.license' package.json)"
keywords="$(jq -c '.keywords' package.json)"

tmp="$(mktemp)"
jq \
  --arg version "$version" \
  --arg description "$description" \
  --arg repository "$repository" \
  --arg homepage "$homepage" \
  --arg license "$license" \
  --argjson keywords "$keywords" \
  '.version = $version
   | .description = $description
   | .repository = $repository
   | .homepage = $homepage
   | .license = $license
   | .keywords = $keywords' \
  .claude-plugin/plugin.json > "$tmp"
mv "$tmp" .claude-plugin/plugin.json

tmp="$(mktemp)"
jq \
  --arg version "$version" \
  --arg description "$description" \
  --arg repository "$repository" \
  --arg homepage "$homepage" \
  --arg license "$license" \
  --argjson keywords "$keywords" \
  '.version = $version
   | .description = $description
   | .repository = $repository
   | .homepage = $homepage
   | .license = $license
   | .keywords = $keywords' \
  .codex-plugin/plugin.json > "$tmp"
mv "$tmp" .codex-plugin/plugin.json

tmp="$(mktemp)"
jq \
  --arg version "$version" \
  --arg description "$description" \
  '.plugins[0].version = $version
   | .plugins[0].description = $description' \
  .claude-plugin/marketplace.json > "$tmp"
mv "$tmp" .claude-plugin/marketplace.json
```

- [ ] **Step 5: Run metadata sync**

Run:

```bash
bash scripts/sync-plugin-versions.sh
```

Expected: no output, exit 0, manifests updated.

- [ ] **Step 6: Run the workflow test and verify it passes**

Run:

```bash
bash scripts/verify-update-versions-workflow.test.sh
```

Expected: `PASS: update-versions and on-release workflow wiring is valid`

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/sync-plugin-versions.sh scripts/verify-update-versions-workflow.test.sh .claude-plugin/plugin.json .codex-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(plugin): sync shared runtime metadata"
```

---

### Task 2: Add Adapter-Based Compatibility Check

**Files:**
- Create: `scripts/verify-runtime-compatibility.test.sh`
- Modify: `package.json`
- Modify: `scripts/verify-update-versions-workflow.test.sh`

**Interfaces:**
- Consumes: package metadata from Task 1
- Produces: `bash scripts/verify-runtime-compatibility.test.sh` and `bun run compat:check`

- [ ] **Step 1: Create failing compatibility script**

Create `scripts/verify-runtime-compatibility.test.sh`:

```bash
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
```

- [ ] **Step 2: Run compatibility script and verify it fails before Task 1 is applied**

If Task 1 is already committed, this step should pass. If running independently before Task 1:

```bash
bash scripts/verify-runtime-compatibility.test.sh
```

Expected before Task 1: FAIL on missing package metadata or manifest drift.
Expected after Task 1: `PASS: runtime compatibility manifests are valid`

- [ ] **Step 3: Make script executable**

Run:

```bash
chmod +x scripts/verify-runtime-compatibility.test.sh
```

- [ ] **Step 4: Add package scripts**

In `package.json`, add these entries under `scripts`:

```json
    "compat:check": "bash scripts/verify-runtime-compatibility.test.sh",
    "compat:preflight": "bash scripts/preflight-runtime-compatibility.sh",
```

Place them after `"typecheck": "tsc --noEmit",`.

- [ ] **Step 5: Create initial preflight script**

Create `scripts/preflight-runtime-compatibility.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

bash scripts/verify-runtime-compatibility.test.sh

echo "PASS: runtime compatibility preflight completed"
```

Run:

```bash
bun run compat:preflight
```

Expected: `PASS: runtime compatibility preflight completed`

- [ ] **Step 6: Keep workflow test workflow-specific**

In `scripts/verify-update-versions-workflow.test.sh`, after JSON file validation and package version checks, add:

```bash
bash "$SCRIPT_DIR/verify-runtime-compatibility.test.sh" >/dev/null
```

Keep the existing workflow assertions for `.github/workflows/update-versions.yml` and `.github/workflows/on-release.yml`.

- [ ] **Step 7: Run checks**

Run:

```bash
bun run compat:check
bash scripts/verify-update-versions-workflow.test.sh
```

Expected:

```text
PASS: runtime compatibility manifests are valid
PASS: update-versions and on-release workflow wiring is valid
```

- [ ] **Step 8: Commit**

```bash
git add package.json scripts/verify-runtime-compatibility.test.sh scripts/preflight-runtime-compatibility.sh scripts/verify-update-versions-workflow.test.sh
git commit -m "test(plugin): add runtime compatibility checks"
```

---

### Task 3: Add Local Full Preflight

**Files:**
- Modify: `scripts/preflight-runtime-compatibility.sh`
- Modify: `package.json`

**Interfaces:**
- Consumes: `bun run compat:check` from Task 2
- Produces: `bun run compat:preflight`

- [ ] **Step 1: Replace preflight script with full implementation**

Replace `scripts/preflight-runtime-compatibility.sh` with:

```bash
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
```

- [ ] **Step 2: Make script executable**

Run:

```bash
chmod +x scripts/preflight-runtime-compatibility.sh
```

- [ ] **Step 3: Run CI-safe check**

Run:

```bash
bun run compat:check
```

Expected: `PASS: runtime compatibility manifests are valid`

- [ ] **Step 4: Run local preflight**

Run:

```bash
bun run compat:preflight
```

Expected final line: `PASS: runtime compatibility preflight completed`

- [ ] **Step 5: Commit**

```bash
git add scripts/preflight-runtime-compatibility.sh package.json
git commit -m "chore(plugin): add runtime compatibility preflight"
```

---

### Task 4: Verify Hook Root Compatibility And Keep Hook Portable

**Files:**
- Modify: `src/cli/mcp.ts`
- Modify: `hooks/hooks.test.ts`
- Test: `hooks/hooks.test.ts`

**Interfaces:**
- Consumes: current hook command `${CLAUDE_PLUGIN_ROOT}/bin/memmem sync --background`
- Produces: root normalization in the MCP launcher without adding shell expansion to `hooks/hooks.json`

- [ ] **Step 1: Add test for root fallback in MCP launcher**

Add this test to `hooks/hooks.test.ts`:

```ts
it('MCP launcher accepts both Claude and Codex plugin root environment names', () => {
  const mcpCli = readRepoFile('src/cli/mcp.ts');

  expect(mcpCli).toContain('process.env.PLUGIN_ROOT');
  expect(mcpCli).toContain('process.env.CLAUDE_PLUGIN_ROOT');
  expect(mcpCli).toContain('findRoot(__dirname)');
});
```

- [ ] **Step 2: Run hook test and verify it fails**

Run:

```bash
bun test hooks/hooks.test.ts
```

Expected: FAIL because `src/cli/mcp.ts` does not yet reference `process.env.PLUGIN_ROOT`.

- [ ] **Step 3: Implement root normalization**

Change this line in `src/cli/mcp.ts`:

```ts
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || findRoot(__dirname);
```

to:

```ts
const PLUGIN_ROOT = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || findRoot(__dirname);
```

Do not change `hooks/hooks.json` to use shell parameter expansion.

- [ ] **Step 4: Run hook tests**

Run:

```bash
bun test hooks/hooks.test.ts
```

Expected: all hook tests pass.

- [ ] **Step 5: Run focused MCP lifecycle tests**

Run:

```bash
bun test src/mcp/server.lifecycle.test.ts
```

Expected: lifecycle test passes.

- [ ] **Step 6: Commit**

```bash
git add src/cli/mcp.ts hooks/hooks.test.ts
git commit -m "fix(plugin): normalize plugin root environment"
```

---

### Task 5: Document Runtime Adapter And Update Semantics

**Files:**
- Modify: `scripts/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: commands from Tasks 2 and 3
- Produces: user-facing and maintainer-facing docs for runtime compatibility

- [ ] **Step 1: Update `scripts/README.md` maintainer section**

Add this section after `lib/check-dependencies.mjs`:

```md
### Runtime compatibility checks

`verify-runtime-compatibility.test.sh` validates the runtime adapter surfaces that can be checked without Claude or Codex binaries:

- `package.json` is the shared metadata source of truth.
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` match shared package metadata.
- `.codex-plugin/plugin.json` has required Codex install metadata and MCP component paths.
- `.agents/plugins/marketplace.json` points Codex at `./plugins/memmem`.

Run:

```bash
bun run compat:check
```

`preflight-runtime-compatibility.sh` is the local full preflight. It additionally runs `claude plugin validate . --strict`, typecheck, focused MCP/hook tests, build, and CLI smoke.

Run:

```bash
bun run compat:preflight
```

Future runtimes should be added as adapter checks rather than by duplicating the plugin payload. A new runtime entry should declare its manifest path, marketplace path if any, metadata fields, validation command, smoke command, and update/cache semantics.
```

- [ ] **Step 2: Update `README.md` installation section**

Add this section after `Installation`:

```md
## Runtime compatibility

memmem ships one shared runtime payload for Claude Code and Codex:

- `skills/`, `agents/`, and `hooks/`
- `.mcp.json`
- `bin/memmem`
- `dist/`

Runtime-specific metadata stays separate:

- Claude Code: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Codex: `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`

Claude Code and Codex update differently. In Claude Code, marketplace refresh and installed plugin update are part of the Claude plugin system, and plugin `version` is the update boundary. In Codex, `codex plugin marketplace upgrade` refreshes marketplace snapshots; installed plugin cache and enabled state are separate.

Maintainers should run the local compatibility preflight before release:

```bash
bun run compat:preflight
```
```

- [ ] **Step 3: Run documentation grep checks**

Run:

```bash
rg -n "compat:check|compat:preflight|Runtime compatibility|Future runtimes|codex plugin marketplace upgrade" README.md scripts/README.md
```

Expected: `compat:check`, `compat:preflight`, and `Future runtimes` appear in `scripts/README.md`; `Runtime compatibility`, `compat:preflight`, and `codex plugin marketplace upgrade` appear in `README.md`.

- [ ] **Step 4: Run compatibility check**

Run:

```bash
bun run compat:check
```

Expected: `PASS: runtime compatibility manifests are valid`

- [ ] **Step 5: Commit**

```bash
git add README.md scripts/README.md
git commit -m "docs(plugin): document runtime compatibility checks"
```

---

### Task 6: Final Verification

**Files:**
- No new files

**Interfaces:**
- Consumes: all previous tasks
- Produces: verified implementation ready for PR or merge workflow

- [ ] **Step 1: Run full local preflight**

Run:

```bash
bun run compat:preflight
```

Expected final line:

```text
PASS: runtime compatibility preflight completed
```

- [ ] **Step 2: Run full test suite**

Run:

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 3: Run build**

Run:

```bash
bun run build
```

Expected:

```text
✓ Built dist/cli-internal.mjs
✓ Built dist/mcp-server.mjs
✓ Built bin/memmem (graceful executable)
```

- [ ] **Step 4: Run git diff check**

Run:

```bash
git diff --check
```

Expected: no output, exit 0.

- [ ] **Step 5: Inspect final changed files**

Run:

```bash
git status --short
```

Expected: only files touched by this plan are changed.

- [ ] **Step 6: Commit verification-only generated outputs if build changed tracked files**

If `bun run build` changes `bin/memmem`, `dist/cli-internal.mjs`, or `dist/mcp-server.mjs`, commit them:

```bash
git add bin/memmem dist/cli-internal.mjs dist/mcp-server.mjs
git commit -m "build: refresh plugin runtime bundles"
```

If build outputs are unchanged, skip this commit.
