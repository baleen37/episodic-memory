# Incremental Sync — Minimal Concurrency + Freshness Design

## Context

memmem syncs local Claude Code / Codex transcripts into an archive and indexes
changed files into memory records. Sync is invoked by a `SessionStart` hook
(`hooks/hooks.json`) running `hooks/run.sh sync`, which calls `runSyncCli()`
(`src/cli/sync.ts`).

Two concrete problems were observed in production:

1. **Concurrent syncs race the same DB.** Three `cli.mjs sync` processes ran at
   once — installed plugin v1.2.1, v1.3.0, and a local dev build — all writing
   the same `~/.config/memmem/conversation-index/conversations.db`. The DB sets
   `PRAGMA journal_mode = WAL` but **no `busy_timeout`** and there is **no
   process-level mutual exclusion**, so concurrent writers can hit `SQLITE_BUSY`
   and redundantly re-extract the same spans.
2. **Mid-session work is invisible until the next session.** Sync only fires on
   `SessionStart` (`startup|resume|clear|compact`), so anything indexed during a
   live session does not appear in search until a new session starts.

This design fixes both with the minimum machinery that comparable real tools
ship. The closest analog, `obra/episodic-memory` (same archive-of-transcripts +
SQLite + Claude/Codex design), solves these with a fail-fast lockfile and WAL
defaults — **no new tables**. We follow that precedent.

## Goals

- A sync run never races another sync run against the same DB, **including when
  different installed versions of the plugin race** (the observed bug).
- Work done mid-session is reflected without waiting for the next `SessionStart`.
- Concurrent reader (MCP `search`/`read`) vs. writer (sync) overlap under WAL is
  safe, not instant-fail.
- Stay minimal: no new tables, no daemon, no watcher, no config knobs.

## Non-goals

- **No file-skip optimization yet.** The current "re-scan every archive file
  each sync" is left as-is. The lock removes the concurrent-run amplification
  and the existing per-span `extraction_state` already skips LLM calls. Whether
  full-file re-scan is actually slow will be **measured after** the lock + Stop
  hook land; only then decide if a watermark is warranted (see Deferred).
- **No watcher daemon / tiered scheduler.** `claude-self-reflect` uses one and it
  is a recurring source of bugs. Per-turn `Stop` hook gives near-real-time
  freshness with no resident process.
- **No debounce state file.** The lock + cheap no-op (mtime copy gate +
  `extraction_state` skip) absorb frequent Stop-hook firing. Add debounce later
  only if measurement shows thrashing.
- **No PID-liveness staleness check.** PID reuse can cause permanent lockout;
  staleness is decided by lock mtime age instead.

## Design

Three changes. New surface: **1 new file (~15 lines), 1 hook entry, 2 PRAGMA
lines.** Zero new tables.

### 1. Single-run lock

A new module `src/core/lock.ts` provides an advisory lock acquired at the start
of `runSyncCli()`.

- **Lock path:** `${getDbPath()}.lock`, i.e. a fixed path **beside the DB**,
  derived from `getSuperpowersDir()` → `getIndexDir()` → `getDbPath()`. Because
  this path is keyed on the shared config/DB location and **not** on the plugin
  install path, all installed versions (v1.2.1, v1.3.0, dev) contend on the same
  lock. This is what fixes the multi-version race.
- **Acquire:** atomic `mkdir` of the lock path (`fs.mkdirSync` throws `EEXIST`
  if held). `mkdir` is atomic on all local filesystems and needs no `O_EXCL`
  subtleties. Write the holder PID into a file inside the lock dir **for
  diagnostics only** (never used for liveness checks).
- **Contention = fail fast.** If the lock is held, `runSyncCli()` logs
  `sync already running; skipping` and returns cleanly (exit 0). Sync is
  idempotent, so the loser doing nothing loses no work — the holder covers the
  same files.
- **Stale reclamation:** if `mkdir` fails with `EEXIST`, stat the lock dir; if
  its mtime is older than a hard ceiling (`STALE_MS = 30 * 60 * 1000`, far longer
  than any real sync), treat it as a crashed holder, remove it, and retry
  acquisition **exactly once**. Staleness uses **mtime age, not PID liveness**
  (PID reuse → permanent-lockout bug, confirmed in the wild).
- **Release:** remove the lock dir in a `finally`. Also register
  SIGINT/SIGTERM handlers to release on interrupt, mirroring `episodic-memory`.

Interface:

```ts
// src/core/lock.ts
/** Returns a release fn, or null if another sync holds the lock. */
export function acquireSyncLock(): (() => void) | null;
```

Wiring in `src/cli/sync.ts`:

```ts
export async function runSyncCli(): Promise<void> {
  const release = acquireSyncLock();
  if (!release) { log.info('sync already running; skipping'); return; }
  const db = openDatabase();
  try {
    const result = await syncTranscripts(db);
    log.info('Done.', { ...result });
  } finally {
    db.close();
    release();
  }
}
```

`syncTranscripts(db)` itself is unchanged.

### 2. Stop hook for mid-session freshness

Add a `Stop` entry to `hooks/hooks.json` alongside the existing `SessionStart`,
running the same command, `async: true`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|clear|compact",
        "hooks": [ { "type": "command",
          "command": "sh ${CLAUDE_PLUGIN_ROOT}/hooks/run.sh sync", "async": true } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command",
          "command": "sh ${CLAUDE_PLUGIN_ROOT}/hooks/run.sh sync", "async": true } ] }
    ]
  }
}
```

`Stop` fires at the end of each turn. Frequent firing is safe and cheap because:
the lock makes overlapping runs no-op immediately, and within a single run the
`copyIfNewer` mtime gate + per-span `extraction_state` skip mean an unchanged
archive does almost no work. `run.sh` is unchanged.

**Known accepted gap:** if the very last turn of a session is still being
written when the session ends and no further sync fires, that turn is indexed at
the next `SessionStart`. This is bounded latency, never data loss, and avoiding
it would require a daemon (rejected).

### 3. SQLite WAL pragmas

In `createDatabase()` (`src/core/db.ts`), after `journal_mode = WAL`:

```ts
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');   // ride out a brief reader/writer overlap
db.exec('PRAGMA synchronous = NORMAL');  // safe: the index is rebuildable from the archive
```

- `busy_timeout = 5000`: the lock already guarantees one sync writer; this only
  covers a sync committing while an MCP `search`/`read` reader is active. 5s is
  far beyond any single per-span transaction. Matches `kuroko1t/claude-vault`.
- `synchronous = NORMAL`: standard WAL companion. Losing the last transaction on
  power loss is acceptable because the archive is the source of truth and the
  index is rebuildable (per CLAUDE.md Memory Architecture Principles).
- Autocheckpoint left at the 1000-page default. No manual checkpointing.

## Testing

Co-located `*.test.ts`, `bun test`, following repo conventions.

`src/core/lock.test.ts`:
- Acquire returns a release fn; a second `acquireSyncLock()` returns `null` while
  held; after `release()`, re-acquire succeeds.
- Stale reclamation: create a lock dir with mtime older than `STALE_MS` → next
  acquire reclaims it and succeeds. (Set mtime via `fs.utimesSync`.)
- Release is idempotent and removes the lock dir.

`src/cli/sync.test.ts` (extend existing):
- When the lock is held, `runSyncCli()` returns without opening the DB / doing
  work (assert via a held lock + spy/log, no `syncTranscripts` effects).

`src/core/db.test.ts`:
- After `openDatabase()`, `PRAGMA busy_timeout` returns `5000` and
  `PRAGMA synchronous` returns `1` (NORMAL).

Embeddings mocked with `__setModelForTests()` to avoid model downloads.

## Deferred (measure first)

- **File-skip / watermark.** If, after lock + Stop hook, full-file re-scan is
  measurably slow on a large archive, add the cheapest sufficient skip. Preferred
  candidate (no new table): a per-`archive_path` high-water mark via
  `SELECT COALESCE(MAX(line_end), 0) FROM memory_records WHERE archive_path = ?`,
  exploiting append-only JSONL — the `obra/episodic-memory` approach. Decide
  based on measurement, not assumption.
- **Debounce state.** If Stop-hook firing proves to thrash, add a minimal
  last-run stamp. Not before evidence.
- **`verify` self-heal.** Reconciling archive-vs-index drift belongs in the
  existing `verify` command if/when drift is observed.

## Summary of changes

| Change | File | Size |
| ------ | ---- | ---- |
| Single-run lock | `src/core/lock.ts` (new) + wire into `runSyncCli` | ~15 lines + ~6 |
| Mid-session trigger | `hooks/hooks.json` `Stop` entry | 1 entry |
| WAL safety | `src/core/db.ts` two PRAGMA lines | 2 lines |

No new tables. No daemon. No config knobs. The lock fixes the concurrency +
multi-version race; the Stop hook fixes staleness; the pragmas make the rare
reader/writer overlap safe.
