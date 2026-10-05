---
name: verify
description: Verify episodic-memory changes end to end through the real wrapper, daemon socket and MCP tools in an isolated data dir.
---

# Verify episodic-memory

Drive the real surfaces (wrapper CLI, `sync` hook, daemon socket, MCP `search`/`read`, `doctor`)
in an isolated data dir. Never point anything at `~/.config/episodic-memory` except read-only
`doctor` / `sqlite3 "file:...?mode=ro"` checks.

## Setup (≈1 min, no model download)

```bash
V=/tmp/emv; rm -rf $V; mkdir -p $V/claude/projects/-work-demo $V/codex/sessions $V/data
cp -cR ~/.config/episodic-memory/models $V/data/models   # APFS clone of the e5 cache
export EPISODIC_MEMORY_DIR=$V/data CLAUDE_CONFIG_DIR=$V/claude CODEX_HOME=$V/codex
# local build instead of the released binary:
#   cargo build --release && export EPISODIC_MEMORY_BIN=$PWD/target/release/episodic-memory
```

Write synthetic Claude lines (`type`, `sessionId`, `cwd`, `timestamp`, `message.content`) into
`$V/claude/projects/-work-demo/*.jsonl`. Keep the data dir path short (socket path limit ~100 bytes).

## Drive

- `bin/episodic-memory sync` → exit 0 immediately; poll
  `sqlite3 "file:$V/data/episodic.db?mode=ro" "select count(*) from exchanges where embedded=1"`.
- `bin/episodic-memory doctor` → `[ok]` lines, exit 0.
- MCP: spawn `bin/episodic-memory mcp`, send newline JSON-RPC `initialize`, then
  `tools/call` `search` / `read` (a ~30-line python stdio client is enough).

Flows worth driving: exact token (`ERRX-4471`-style) ranks #1; Korean particle query
(`검색을` finds `검색추천`); DO NOT INDEX marker file is skipped; append to a source then
`sync` → new turn searchable, archive inode unchanged, trailing partial line not copied;
completing the partial line → last exchange re-created; `read` with `../` escape → `path outside
archive`; `EPISODIC_MEMORY_DISABLE=1 sync` → no-op; a second `daemon` exits 0 at once.

## Cleanup

`kill $(head -1 $V/data/daemon-*.lock)`; `rm -rf $V`.

## Gotchas

- `read` still opens archive files of DO NOT INDEX sessions (only indexing is skipped).
- Search always fills results with vector neighbours; scores are normalized to the top hit,
  so unrelated results can show high scores.
- Old 3.x sessions' processes can recreate `~/.config/episodic-memory/conversation-index/`.
