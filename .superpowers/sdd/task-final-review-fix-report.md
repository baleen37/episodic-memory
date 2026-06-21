# Final Review Fix Report

Date: 2026-06-21
Worktree: `/Users/jito.hello/dev/wooto/memmem/.worktrees/00021-quick-nebula-hamilton`

## Scope

Addressed whole-branch review findings for runtime compatibility across Claude Code and Codex:

- refreshed the copied Codex marketplace plugin view at `plugins/memmem`
- tightened compatibility checks so copied-view drift fails for manifests, `.mcp.json`, and the copied MCP launcher source
- switched the update workflow from inline jq sync to repo scripts
- made the update workflow refresh and commit the copied plugin view
- added `bun run compat:check` to regular CI

## Files Changed

- `.github/workflows/ci.yml`
- `.github/workflows/update-versions.yml`
- `scripts/verify-runtime-compatibility.test.sh`
- `scripts/verify-update-versions-workflow.test.sh`
- `plugins/memmem/.claude-plugin/plugin.json`
- `plugins/memmem/.codex-plugin/plugin.json`
- `plugins/memmem/README.md`
- `plugins/memmem/dist/cli-internal.mjs`
- `plugins/memmem/package.json`
- `plugins/memmem/scripts/README.md`
- `plugins/memmem/scripts/preflight-runtime-compatibility.sh`
- `plugins/memmem/scripts/sync-plugin-versions.sh`
- `plugins/memmem/scripts/verify-runtime-compatibility.test.sh`
- `plugins/memmem/scripts/verify-update-versions-workflow.test.sh`
- `plugins/memmem/src/cli/mcp.ts`

## Commands Run

1. `bash scripts/sync-codex-marketplace-plugin.sh`
   - exit 0
   - refreshed `plugins/memmem` from the root plugin tree

2. `bun run compat:check`
   - exit 0
   - output:
     - `$ bash scripts/verify-runtime-compatibility.test.sh`
     - `PASS: runtime compatibility manifests are valid`

3. `bash scripts/verify-update-versions-workflow.test.sh`
   - exit 0
   - output:
     - `PASS: update-versions and on-release workflow wiring is valid`

4. Focused copied-plugin proof
   - exit 0
   - output summary:
     - `plugins/memmem/src/cli/mcp.ts` contains `process.env.PLUGIN_ROOT`
     - copied Claude manifest description matches package metadata
     - copied Codex manifest description matches package metadata
     - copied `.mcp.json` uses `command=./bin/memmem` and `cwd=.`

5. `git diff --check`
   - exit 0

## Exact Output Summary

- `bun run compat:check`:
  - `$ bash scripts/verify-runtime-compatibility.test.sh`
  - `PASS: runtime compatibility manifests are valid`
- `bash scripts/verify-update-versions-workflow.test.sh`:
  - `PASS: update-versions and on-release workflow wiring is valid`
- focused copied-plugin proof:
  - `launcher: 25:const PLUGIN_ROOT = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || findRoot(__dirname);`
  - `claude-description: Memmem - Conversation memory with semantic search across Claude Code and Codex sessions`
  - `codex-description: Memmem - Conversation memory with semantic search across Claude Code and Codex sessions`
  - `mcp-command: ./bin/memmem`
  - `mcp-cwd: .`

## Self-Review

- The update workflow now delegates shared metadata sync to `scripts/sync-plugin-versions.sh` and explicitly refreshes the copied Codex marketplace plugin view.
- The workflow commit gate and `git add` include `plugins/memmem`, so copied-view updates are not silently dropped.
- Compatibility checks remain CI-safe and do not require Claude or Codex CLI binaries.
- Codex-only fields remain isolated to `.codex-plugin/plugin.json`; no Codex `interface` field was added to `.claude-plugin/plugin.json`.
- `.agents/plugins/marketplace.json` was not turned into a version source; package metadata remains the source of truth for shared fields.
