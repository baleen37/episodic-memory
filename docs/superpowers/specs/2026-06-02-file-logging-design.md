# File Logging Design

Date: 2026-06-02

## Problem

`src/core/logger.ts` currently writes only to stderr. When the SessionStart hook
runs `memmem sync` automatically, that stderr output is not captured anywhere, so
errors during extraction (e.g. the Z.AI `429: Insufficient balance` failures that
produced 1600 errored extraction spans) are lost. The only surviving record of
those failures was `extraction_state.error_message` in the database — there was no
log file to inspect.

We want all log output to also be written to a date-based log file so failures and
overall behavior can be reviewed after the fact.

## Goals

- Capture the full operational log (not just errors) to a file.
- Keep stderr output exactly as-is for real-time visibility.
- Apply to every execution path: CLI (`sync`/`search`/`read`/`stats`/`verify`) and
  the MCP server — both already route through the single `emit()` function.
- Allow `debug` level to be enabled later via the existing `MEMMEM_LOG_LEVEL`.
- Bound disk usage with automatic retention.

## Non-Goals

- No new log format. The existing line format is reused verbatim.
- No async write queue / worker. Buffering + synchronous flush is sufficient.
- No log rotation by size. Date-based files + retention is the chosen model.
- No change to any of the ~8 call sites. They keep using `log.info/warn/error/debug`.

## Key Decisions

| Decision | Choice |
| --- | --- |
| Output targets | stderr (immediate) **and** file (buffered) |
| Level control | Existing `MEMMEM_LOG_LEVEL` (default `info`; `silent` disables both) |
| File path | `~/.config/memmem/logs/YYYY-MM-DD.log` (append) |
| Path helper | Reuse existing `getLogFilePath()` / `getLogDir()` from `src/core/paths.ts` |
| Retention | Delete `YYYY-MM-DD.log` files older than 14 days |
| Flush triggers | (a) buffer reaches 64 lines, (b) 1s since last flush, (c) process exit |
| Scope | All CLI + MCP executions (single `emit()` chokepoint) |

## Architecture

Only `src/core/logger.ts` changes. stderr stays immediate; file writes are buffered
in memory and flushed under the conditions above.

```
emit(level, msg, meta)
  ├─ level gate                       (existing)
  ├─ format line                      (existing)
  ├─ process.stderr.write(line)       (existing, immediate)
  └─ bufferLine(line)                 (new)
        ├─ buffer.push(line)
        ├─ if (buffer.length >= 64) flush()
        └─ else scheduleFlush()        (1s timer, skipped if already scheduled)

flush()
  ├─ if buffer empty → clear timer, return
  ├─ pruneOldLogs() once per process  (first flush only)
  ├─ appendFileSync(getLogFilePath(), buffer.join(''))   // getLogFilePath ensures logs/ exists
  ├─ buffer = []
  └─ clear timer

process exit hooks (registered once at module load)
  ├─ process.on('exit',  () => flush())   // sync only — appendFileSync is sync, safe
  ├─ process.on('SIGINT',  () => { flush(); process.exit(130); })
  └─ process.on('SIGTERM', () => { flush(); process.exit(143); })
```

### Why these flush triggers

- **64 lines**: bounds memory and write frequency for burst logging (a sync can emit
  hundreds of lines).
- **1s timer**: ensures a long-lived MCP process flushes recent logs without waiting
  for the size threshold or exit. The timer is `unref()`'d so it never keeps a
  finishing CLI process alive.
- **Process exit**: guarantees the tail of the buffer is written. `process.exit()`
  (used at several call sites in `cli/main.ts`, `mcp/server.ts`, `cli-graceful.mjs`)
  fires the `'exit'` event, so a single `'exit'` handler covers the normal-exit and
  explicit-exit paths. `SIGINT`/`SIGTERM` are added separately because they do not
  trigger `'exit'` on their own; no existing custom handlers for these signals were
  found, so adding listeners is safe (Node allows multiple listeners regardless).

### Path & retention details

- `getLogFilePath()` (paths.ts:83) already returns
  `~/.config/memmem/logs/<YYYY-MM-DD>.log` and `getLogDir()` ensures the directory
  exists, honoring the `CONVERSATION_MEMORY_CONFIG_DIR` / `MEMMEM_CONFIG_DIR`
  overrides. Both are reused as-is.
- Retention: on the first flush of the process, scan `getLogDir()` for entries
  matching `^\d{4}-\d{2}-\d{2}\.log$`, parse the date, and delete any older than 14
  days relative to today. Run once per process (not per flush).
- Date boundary: the file is chosen at flush time by today's date. A buffer that
  spans midnight lands in the file of the flush moment; with a 1s timer this is
  negligible. Simplicity over exactness here.

### Failure handling

- File write failures (`appendFileSync` throw) are swallowed — logging must never
  break the primary operation. The buffer is still cleared on failure to avoid
  unbounded growth.
- stderr output is unaffected by any file error.
- `MEMMEM_LOG_LEVEL=silent` short-circuits in the existing level gate, so nothing is
  buffered or written to file either.

## Testing

New `src/core/logger.test.ts`. Tests inject a temp log directory via the
`CONVERSATION_MEMORY_CONFIG_DIR` env override (no new test hook needed for the
directory) and force flushing via a small test-only export.

Test-only export:

- `__flushForTests()` — synchronously flush the buffer so assertions don't wait on
  the 1s timer.

Cases:

1. After an `info` log + `__flushForTests()`, today's `YYYY-MM-DD.log` contains the
   formatted line.
2. Buffer auto-flushes once it reaches 64 lines (file written without explicit
   flush).
3. `MEMMEM_LOG_LEVEL=silent` → nothing buffered and no file written.
4. Retention: a dummy `<15-days-ago>.log` is deleted after a flush; a
   `<13-days-ago>.log` is retained.

Tests set/restore `process.env.MEMMEM_LOG_LEVEL` and the config-dir override around
each case, and use a unique temp dir per test to avoid cross-test contamination.

## Trade-offs

- Buffering adds state (buffer array, timer handle, once-per-process retention flag,
  exit hooks) compared to a plain synchronous `appendFileSync` per line, but reduces
  I/O frequency — favorable for the long-lived MCP process. Accepted per user choice.
- Synchronous flush (`appendFileSync`) is used even though writes are buffered. This
  keeps the exit-path flush correct (`'exit'` handlers must be synchronous) and
  avoids async-queue complexity. The flush is infrequent, so the cost is acceptable.

## Affected files

- `src/core/logger.ts` — add buffered file sink, flush logic, retention, exit hooks.
- `src/core/logger.test.ts` — new test file.
- Rebuild required afterward: `bun run build` (logger is bundled into CLI + MCP).
