# memmem-cli-mcp: sync, search, and MCP share an isolated memory index

**What this covers**: The merged sync/source-boundary refactor from PR #84 through the real `bin/memmem` CLI and MCP stdio interface.

## Pre-state

Run from the repository root with dependencies installed. Build a fresh runtime
before starting the scenario:

```bash
set -euo pipefail
bun run build
SCENARIO_ROOT="$(mktemp -d)"
export HOME="$SCENARIO_ROOT/home"
export CONVERSATION_MEMORY_CONFIG_DIR="$SCENARIO_ROOT/config"
export CONVERSATION_MEMORY_DB_PATH="$SCENARIO_ROOT/memories.db"
export CLAUDE_CONFIG_DIR="$SCENARIO_ROOT/claude"
export CODEX_HOME="$SCENARIO_ROOT/codex"
mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR/projects/demo" "$CODEX_HOME/sessions"
```

No LLM provider is required. The embedding model must already be available in
the local cache. Use the scenario's own tmux session named `memmem-cli-mcp`.

## Steps

1. Seed one Claude transcript in `CLAUDE_CONFIG_DIR/projects/demo/session.jsonl`, then run the user-facing sync command in tmux:

   ```bash
   set -euo pipefail
   bun -e 'const { mkdirSync, writeFileSync } = await import("node:fs"); mkdirSync(process.env.CLAUDE_CONFIG_DIR + "/projects/demo", { recursive: true }); writeFileSync(process.env.CLAUDE_CONFIG_DIR + "/projects/demo/session.jsonl", [JSON.stringify({ type: "user", timestamp: "2026-08-13T00:00:00Z", message: { role: "user", content: "How should sync architecture be organized?" } }), JSON.stringify({ type: "assistant", timestamp: "2026-08-13T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Keep archive discovery in the CLI and indexing policy in core." }] } })].join("\n") + "\n")'
   tmux new-session -d -s memmem-cli-mcp -x 200 -y 50 "sh -c './bin/memmem sync 2>\"$SCENARIO_ROOT/sync.stderr\"; rc=\$?; echo EXIT:\$rc; sleep 2'"
   ```

2. Wait for the sync session to exit, inspect the captured pane and stderr, and confirm the archive exists:

   ```bash
   set -euo pipefail
   while ! tmux capture-pane -t memmem-cli-mcp -p 2>/dev/null | grep -F "EXIT:" >/dev/null; do sleep 0.2; done
   tmux capture-pane -t memmem-cli-mcp -p
   grep -F "EXIT:0" <(tmux capture-pane -t memmem-cli-mcp -p)
   grep -F "Done." "$SCENARIO_ROOT/sync.stderr"
   test -f "$CONVERSATION_MEMORY_CONFIG_DIR/conversation-archive/claude-code-projects/demo/session.jsonl"
   ```

3. Seed one memory row directly into the isolated database as test fixture setup, then search through the real CLI:

   ```bash
   set -euo pipefail
   bun -e 'import { embedPassageBatch } from "./src/core/embeddings.js"; import { openMemoryDb } from "./src/core/memory/schema.js"; import { insertMemories } from "./src/core/memory/store.js"; const memory = "Sync indexing policy belongs in the core module."; const [embedding] = await embedPassageBatch([memory]); const db = openMemoryDb(); insertMemories(db, [{ id: "e2e-memory", memory, metadata: { user_id: "local", agent_id: "e2e" }, embedding }]); db.close()'
   tmux new-session -d -s memmem-cli-mcp -x 200 -y 50 "sh -c './bin/memmem search \"sync indexing policy\" --limit 5 2>\"$SCENARIO_ROOT/search.stderr\"; rc=\$?; echo EXIT:\$rc; sleep 2'"
   while ! tmux capture-pane -t memmem-cli-mcp -p 2>/dev/null | grep -F "EXIT:" >/dev/null; do sleep 0.2; done
   tmux capture-pane -t memmem-cli-mcp -p | tee "$SCENARIO_ROOT/search-pane.txt"
   ```

4. Verify the CLI result against the authoritative database fixture:

   ```bash
   set -euo pipefail
   grep -F "Sync indexing policy belongs in the core module." "$SCENARIO_ROOT/search-pane.txt"
   grep -F "Score:" "$SCENARIO_ROOT/search-pane.txt"
   bun -e 'import { openMemoryDb } from "./src/core/memory/schema.js"; const db = openMemoryDb(); console.log(db.query("SELECT id, metadata FROM memories WHERE id = ?").get("e2e-memory")); db.close()'
   ```

   The scenario fails if the CLI omits the seeded memory, prints no score, or
   the database row is absent. A successful process with empty output is not a
   pass.

5. Confirm the intentionally unsupported date options fail explicitly:

   ```bash
   set -euo pipefail
   if ./bin/memmem search "sync" --after 2026-01-01 >"$SCENARIO_ROOT/unsupported.txt" 2>&1; then exit 1; fi
   grep -F -- "--after/--before are not yet supported" "$SCENARIO_ROOT/unsupported.txt"
   ```

6. Drive the real `bin/memmem mcp` stdio interface and call the exposed search tool:

   ```bash
   set -euo pipefail
   tmux new-session -d -s memmem-cli-mcp -x 200 -y 50 "sh -c 'PLUGIN_ROOT=\"$PWD\" bun -e '\''import { Client } from "@modelcontextprotocol/sdk/client/index.js"; import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"; const transport = new StdioClientTransport({ command: process.cwd() + "/bin/memmem", args: ["mcp"], env: { ...process.env, PLUGIN_ROOT: process.cwd() } }); const client = new Client({ name: "memmem-scenario", version: "1.0.0" }); await client.connect(transport); const listed = await client.listTools(); const result = await client.callTool({ name: "search", arguments: { query: "sync indexing policy", limit: 5 } }); console.log(JSON.stringify({ tools: listed.tools.map((tool) => tool.name), result }, null, 2)); await client.close();'\'' 2>\"$SCENARIO_ROOT/mcp.stderr\"; rc=\$?; echo EXIT:\$rc; sleep 2'"
   while ! tmux capture-pane -t memmem-cli-mcp -p 2>/dev/null | grep -F "EXIT:" >/dev/null; do sleep 0.2; done
   tmux capture-pane -t memmem-cli-mcp -p | tee "$SCENARIO_ROOT/mcp-pane.txt"
   ```

7. Assert the MCP surface and result:

   ```bash
   set -euo pipefail
   grep -F '"tools": [' "$SCENARIO_ROOT/mcp-pane.txt"
   grep -F '"search"' "$SCENARIO_ROOT/mcp-pane.txt"
   grep -F 'Sync indexing policy belongs in the core module.' "$SCENARIO_ROOT/mcp-pane.txt"
   if grep -F '"fetch"' "$SCENARIO_ROOT/mcp-pane.txt"; then exit 1; fi
   ```

   The scenario fails if initialize/list-tools does not expose exactly the
   current search surface, if the call returns an MCP error, or if the returned
   memory text differs from the CLI/database evidence.

## Expected

- Sync exits successfully, reports `Done.`, and copies the seeded transcript to the isolated archive.
- CLI search renders the seeded memory text and a `Score:` line.
- CLI `--after` produces the explicit unsupported-option error and exits non-zero.
- MCP initialize succeeds, `tools/list` exposes `search` and not `fetch`, and `tools/call` returns the same seeded memory text.
- The SQLite row remains present with the expected memory text and local scope metadata.

## Cleanup

```bash
tmux kill-session -t memmem-cli-mcp 2>/dev/null || true
rm -r "$SCENARIO_ROOT"
```

Only the scenario's temporary directory and tmux session may be removed.

## Sharp edges

- Always rebuild before starting the tmux session; `bin/memmem` executes tracked `dist/` artifacts.
- Keep `CONVERSATION_MEMORY_DB_PATH` and `CONVERSATION_MEMORY_CONFIG_DIR` inside `SCENARIO_ROOT` so the real local index is never touched.
- The fixture insert is setup only. The behavior under test is the real CLI and MCP path reading that fixture.
- Use `tmux capture-pane` plus the SQLite query as evidence. A zero exit code with no rendered memory is a failure.
