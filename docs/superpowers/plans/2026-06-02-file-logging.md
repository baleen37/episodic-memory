# File Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror all stderr log output to a date-based log file at `~/.config/memmem/logs/YYYY-MM-DD.log`, buffered, with 14-day retention.

**Architecture:** Add a buffered file sink inside `src/core/logger.ts`'s single `emit()` chokepoint. stderr stays immediate; file writes accumulate in a line buffer and flush at 64 lines, after 1s, or on process exit. Reuse the existing `getLogFilePath()`/`getLogDir()` helpers from `src/core/paths.ts`. No call sites change.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun:sqlite` unused here), Node `fs` (`appendFileSync`, `readdirSync`, `unlinkSync`).

---

## Spec

See `docs/superpowers/specs/2026-06-02-file-logging-design.md`.

## File Structure

- **Modify** `src/core/logger.ts` — add file buffer, flush triggers, retention, exit hooks, and a `__flushForTests()` export. The existing `emit()` and public `log` API stay unchanged in shape.
- **Modify** `src/core/logger.test.ts` — add file-sink tests; harden existing tests so the new file sink never writes to the real config dir during the suite.

`getLogFilePath()` and `getLogDir()` already exist in `src/core/paths.ts` (lines 76-86) and return `~/.config/memmem/logs/<YYYY-MM-DD>.log`, honoring `CONVERSATION_MEMORY_CONFIG_DIR` / `MEMMEM_CONFIG_DIR`. They are reused as-is — do not modify `paths.ts`.

## Current logger.ts (for reference)

The `emit()` function currently is (src/core/logger.ts:24-31):

```typescript
function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (getThreshold() < LEVELS[level]) return;
  const ts = new Date().toISOString();
  const line = meta !== undefined
    ? `[${ts}] ${level.toUpperCase()} ${msg} ${JSON.stringify(meta)}\n`
    : `[${ts}] ${level.toUpperCase()} ${msg}\n`;
  process.stderr.write(line);
}
```

---

### Task 1: Harden existing logger tests against the real config dir

The file sink will write to `getLogDir()`. Before adding it, point the test suite's
config dir at a temp directory so no test ever touches `~/.config/memmem/logs/`. This
task only changes the test file and must keep all existing tests green.

**Files:**
- Modify: `src/core/logger.test.ts:1-20` (imports + top-level setup/teardown)

- [ ] **Step 1: Add a temp config dir override around the whole suite**

Replace the top of `src/core/logger.test.ts` (lines 1-20) with:

```typescript
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, utimesSync } from 'fs';
import { log } from './logger.js';

describe('logger', () => {
  let stderrSpy: ReturnType<typeof spyOn<typeof process.stderr, 'write'>>;
  let originalLevel: string | undefined;
  let originalConfigDir: string | undefined;
  let tempConfigDir: string;

  beforeEach(() => {
    originalLevel = process.env.MEMMEM_LOG_LEVEL;
    originalConfigDir = process.env.CONVERSATION_MEMORY_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), 'memmem-log-'));
    process.env.CONVERSATION_MEMORY_CONFIG_DIR = tempConfigDir;
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalLevel === undefined) {
      delete process.env.MEMMEM_LOG_LEVEL;
    } else {
      process.env.MEMMEM_LOG_LEVEL = originalLevel;
    }
    if (originalConfigDir === undefined) {
      delete process.env.CONVERSATION_MEMORY_CONFIG_DIR;
    } else {
      process.env.CONVERSATION_MEMORY_CONFIG_DIR = originalConfigDir;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
    stderrSpy.mockRestore();
  });
```

Note: the inner `describe` blocks keep their own `beforeEach` that set/delete
`MEMMEM_LOG_LEVEL` — those run after this outer `beforeEach`, which is the existing
behavior. Leave them unchanged.

- [ ] **Step 2: Run the existing tests, confirm still green**

Run: `bun test src/core/logger.test.ts`
Expected: PASS (all existing tests). The file sink does not exist yet, so behavior is
unchanged; this only verifies the harness edits didn't break anything.

- [ ] **Step 3: Commit**

```bash
git add src/core/logger.test.ts
git commit -m "test(logger): isolate tests with temp config dir"
```

---

### Task 2: Buffered file sink with explicit flush

Add the file buffer and a test-only flush, wired into `emit()`. Retention and exit
hooks come in later tasks.

**Files:**
- Modify: `src/core/logger.ts` (add imports, buffer state, `flushLogBuffer`, `__flushForTests`, call from `emit`)
- Modify: `src/core/logger.test.ts` (new test)

- [ ] **Step 1: Write the failing test**

Add this `describe` block inside the top-level `describe('logger', ...)` in
`src/core/logger.test.ts`, after the existing `output format` block:

```typescript
  describe('file sink', () => {
    beforeEach(() => {
      delete process.env.MEMMEM_LOG_LEVEL;
    });

    test('flushed info line is written to today log file', () => {
      log.info('file sink line');
      __flushForTests();
      const date = new Date().toISOString().split('T')[0];
      const logPath = join(tempConfigDir, 'logs', `${date}.log`);
      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, 'utf8')).toContain('INFO file sink line');
    });
  });
```

Add `__flushForTests` to the import from `./logger.js` at the top of the file:

```typescript
import { log, __flushForTests } from './logger.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/logger.test.ts -t "flushed info line"`
Expected: FAIL — `__flushForTests` is not exported (import error / undefined).

- [ ] **Step 3: Implement the buffered sink**

In `src/core/logger.ts`, add an import at the top (after the existing header comment,
before `export type LogLevel`):

```typescript
import { appendFileSync } from 'fs';
import { getLogFilePath } from './paths.js';
```

Add buffer state and flush logic above `function emit(...)`:

```typescript
const FLUSH_LINE_THRESHOLD = 64;
let buffer: string[] = [];

function flushLogBuffer(): void {
  if (buffer.length === 0) return;
  const lines = buffer.join('');
  buffer = [];
  try {
    appendFileSync(getLogFilePath(), lines);
  } catch {
    // Logging must never break the primary operation; drop on failure.
  }
}

function bufferLine(line: string): void {
  buffer.push(line);
  if (buffer.length >= FLUSH_LINE_THRESHOLD) {
    flushLogBuffer();
  }
}
```

Add the `bufferLine` call inside `emit()`, right after the existing
`process.stderr.write(line);`:

```typescript
  process.stderr.write(line);
  bufferLine(line);
```

Add the test-only export at the end of the file (after the legacy shims):

```typescript
/** Test-only: synchronously flush the file buffer. */
export function __flushForTests(): void {
  flushLogBuffer();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/logger.test.ts -t "flushed info line"`
Expected: PASS

- [ ] **Step 5: Run the full logger suite**

Run: `bun test src/core/logger.test.ts`
Expected: PASS (existing tests + new file-sink test).

- [ ] **Step 6: Commit**

```bash
git add src/core/logger.ts src/core/logger.test.ts
git commit -m "feat(logger): add buffered file sink"
```

---

### Task 3: Auto-flush at line threshold

Verify the buffer flushes on its own once it reaches 64 lines, without an explicit
flush call. The implementation already does this (Task 2's `bufferLine`); this task
adds the test that proves it.

**Files:**
- Modify: `src/core/logger.test.ts` (new test)

- [ ] **Step 1: Write the failing-then-passing test**

Add inside the `describe('file sink', ...)` block:

```typescript
    test('auto-flushes after 64 buffered lines', () => {
      for (let i = 0; i < 64; i++) {
        log.info(`bulk line ${i}`);
      }
      const date = new Date().toISOString().split('T')[0];
      const logPath = join(tempConfigDir, 'logs', `${date}.log`);
      expect(existsSync(logPath)).toBe(true);
      const contents = readFileSync(logPath, 'utf8');
      expect(contents).toContain('bulk line 0');
      expect(contents).toContain('bulk line 63');
    });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test src/core/logger.test.ts -t "auto-flushes after 64"`
Expected: PASS (the 64th `log.info` triggers `flushLogBuffer` inside `bufferLine`).

- [ ] **Step 3: Commit**

```bash
git add src/core/logger.test.ts
git commit -m "test(logger): verify 64-line auto-flush"
```

---

### Task 4: Silent level writes nothing to file

When `MEMMEM_LOG_LEVEL=silent`, the level gate in `emit()` returns before
`bufferLine`, so nothing is buffered or written. Add the test that locks this in.

**Files:**
- Modify: `src/core/logger.test.ts` (new test)

- [ ] **Step 1: Write the test**

Add inside the `describe('file sink', ...)` block:

```typescript
    test('silent level writes no file', () => {
      process.env.MEMMEM_LOG_LEVEL = 'silent';
      log.error('should not be written');
      __flushForTests();
      const logsDir = join(tempConfigDir, 'logs');
      // Either the logs dir was never created, or it contains no log files.
      const files = existsSync(logsDir) ? readdirSync(logsDir) : [];
      expect(files.filter(f => f.endsWith('.log'))).toEqual([]);
    });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test src/core/logger.test.ts -t "silent level writes no file"`
Expected: PASS

Note: `getLogFilePath()` calls `getLogDir()` which `ensureDir`s the logs folder — but
that only runs inside `flushLogBuffer`, which returns early when the buffer is empty.
So with silent level the folder is never created. The test tolerates both outcomes.

- [ ] **Step 3: Commit**

```bash
git add src/core/logger.test.ts
git commit -m "test(logger): silent level skips file sink"
```

---

### Task 5: 14-day retention

On the first flush of a process, delete `YYYY-MM-DD.log` files older than 14 days.

**Files:**
- Modify: `src/core/logger.ts` (add retention, call once from `flushLogBuffer`)
- Modify: `src/core/logger.test.ts` (new test)

- [ ] **Step 1: Write the failing test**

Add inside the `describe('file sink', ...)` block:

```typescript
    test('prunes log files older than 14 days, keeps recent', () => {
      const logsDir = join(tempConfigDir, 'logs');
      // getLogDir() ensures the dir; create it via a real flush first.
      log.info('seed');
      __flushForTests();
      expect(existsSync(logsDir)).toBe(true);

      const DAY_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const oldDate = new Date(now - 15 * DAY_MS).toISOString().split('T')[0];
      const recentDate = new Date(now - 13 * DAY_MS).toISOString().split('T')[0];
      const oldPath = join(logsDir, `${oldDate}.log`);
      const recentPath = join(logsDir, `${recentDate}.log`);
      writeFileSync(oldPath, 'old\n');
      writeFileSync(recentPath, 'recent\n');

      // Retention runs once per process and already ran on the seed flush above.
      // Force it to run again for this test via the test-only reset + flush.
      __resetRetentionForTests();
      log.info('trigger');
      __flushForTests();

      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(recentPath)).toBe(true);
    });
```

Add `__resetRetentionForTests` to the import:

```typescript
import { log, __flushForTests, __resetRetentionForTests } from './logger.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/logger.test.ts -t "prunes log files older than 14"`
Expected: FAIL — `__resetRetentionForTests` not exported, and pruning not implemented.

- [ ] **Step 3: Implement retention**

In `src/core/logger.ts`, extend the `fs`/`paths` imports:

```typescript
import { appendFileSync, readdirSync, unlinkSync } from 'fs';
import { getLogFilePath, getLogDir } from './paths.js';
import { join } from 'path';
```

Add retention state and function (above `flushLogBuffer`):

```typescript
const RETENTION_DAYS = 14;
let retentionDone = false;

function pruneOldLogs(): void {
  const dir = getLogDir();
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const match = name.match(/^(\d{4})-(\d{2})-(\d{2})\.log$/);
    if (!match) continue;
    const fileTime = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (fileTime < cutoff) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // ignore individual delete failures
      }
    }
  }
}
```

Call it once at the start of `flushLogBuffer`, after the empty-buffer early return:

```typescript
function flushLogBuffer(): void {
  if (buffer.length === 0) return;
  if (!retentionDone) {
    retentionDone = true;
    pruneOldLogs();
  }
  const lines = buffer.join('');
  buffer = [];
  try {
    appendFileSync(getLogFilePath(), lines);
  } catch {
    // Logging must never break the primary operation; drop on failure.
  }
}
```

Add the test-only reset near `__flushForTests`:

```typescript
/** Test-only: allow retention to run again on the next flush. */
export function __resetRetentionForTests(): void {
  retentionDone = false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/logger.test.ts -t "prunes log files older than 14"`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `bun test src/core/logger.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/logger.ts src/core/logger.test.ts
git commit -m "feat(logger): prune log files older than 14 days"
```

---

### Task 6: Timer + exit-hook flush

Add a 1s scheduled flush (so long-lived MCP processes flush without hitting the size
threshold) and process-exit hooks (so the buffer tail is always written). These are
hard to assert deterministically in a unit test, so this task verifies behavior
indirectly: the timer is `unref()`'d (does not keep the process alive) and the exit
hooks are registered without throwing.

**Files:**
- Modify: `src/core/logger.ts` (add `scheduleFlush`, call from `bufferLine`, register exit hooks)
- Modify: `src/core/logger.test.ts` (new test)

- [ ] **Step 1: Implement scheduled flush + exit hooks**

In `src/core/logger.ts`, add timer state above `bufferLine`:

```typescript
const FLUSH_INTERVAL_MS = 1000;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushLogBuffer();
  }, FLUSH_INTERVAL_MS);
  // Do not keep a finishing CLI process alive just for a pending flush.
  if (typeof flushTimer.unref === 'function') {
    flushTimer.unref();
  }
}
```

Update `bufferLine` to schedule a flush when it does not flush immediately, and to
clear the timer when it does:

```typescript
function bufferLine(line: string): void {
  buffer.push(line);
  if (buffer.length >= FLUSH_LINE_THRESHOLD) {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushLogBuffer();
  } else {
    scheduleFlush();
  }
}
```

Register exit hooks once, at module load (place after the `log` object definition):

```typescript
let exitHooksRegistered = false;

function registerExitHooks(): void {
  if (exitHooksRegistered) return;
  exitHooksRegistered = true;
  process.on('exit', () => flushLogBuffer());
  process.on('SIGINT', () => {
    flushLogBuffer();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    flushLogBuffer();
    process.exit(143);
  });
}

registerExitHooks();
```

- [ ] **Step 2: Write a test that the timer does not block the suite**

Add inside the `describe('file sink', ...)` block:

```typescript
    test('logging schedules a flush without hanging (unref timer)', () => {
      log.info('scheduled flush line');
      // If the timer were not unref()'d it could keep handles open; we assert the
      // buffer still flushes on demand and the call returns synchronously.
      __flushForTests();
      const date = new Date().toISOString().split('T')[0];
      const logPath = join(tempConfigDir, 'logs', `${date}.log`);
      expect(readFileSync(logPath, 'utf8')).toContain('scheduled flush line');
    });
```

- [ ] **Step 3: Run the full suite**

Run: `bun test src/core/logger.test.ts`
Expected: PASS, and the test process exits promptly (the `unref()`'d timer does not
hold it open).

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/logger.ts src/core/logger.test.ts
git commit -m "feat(logger): flush on timer and process exit"
```

---

### Task 7: Build and end-to-end verification

The logger is bundled into the CLI and MCP outputs. Rebuild and confirm a real run
produces a log file.

**Files:**
- No source changes. Build + manual verification only.

- [ ] **Step 1: Build**

Run: `bun run build`
Expected: completes without error; `dist/cli.mjs` and `dist/mcp-server.mjs` updated.

- [ ] **Step 2: Run a CLI command against a temp config dir and confirm a log file appears**

Run:
```bash
TMP_CFG=$(mktemp -d)
CONVERSATION_MEMORY_CONFIG_DIR="$TMP_CFG" bun run dist/cli.mjs stats 2>/dev/null
ls "$TMP_CFG/logs/"
cat "$TMP_CFG/logs/"*.log | head -5
rm -rf "$TMP_CFG"
```
Expected: `logs/` contains a `YYYY-MM-DD.log` file with formatted log lines (e.g.
`[<iso>] INFO ...`). Note: with an empty temp config dir there is no DB, so `stats`
may log an error and exit non-zero — that is fine; the point is that the log file is
created and contains lines.

- [ ] **Step 3: Run the full project test suite**

Run: `bun test`
Expected: PASS (no regressions in other suites).

- [ ] **Step 4: Final commit (if anything changed) / done**

```bash
git status
# If dist/ is tracked and changed:
git add dist
git commit -m "build: rebuild bundles with file logging"
```

If `dist/` is gitignored, skip the commit — the build output is not tracked.

---

## Self-Review Notes

- **Spec coverage:** stderr+file (Task 2), level reuse incl. silent (Task 4) and
  debug (existing tests), date-based path via `getLogFilePath` (Task 2), 14-day
  retention (Task 5), flush triggers — 64 lines (Task 3), 1s timer + exit (Task 6),
  all-execution scope via `emit` chokepoint (Task 2), rebuild (Task 7). All covered.
- **Type consistency:** `flushLogBuffer`, `bufferLine`, `pruneOldLogs`,
  `scheduleFlush`, `registerExitHooks`, `__flushForTests`, `__resetRetentionForTests`
  used consistently across tasks. Constants `FLUSH_LINE_THRESHOLD`,
  `FLUSH_INTERVAL_MS`, `RETENTION_DAYS` defined once.
- **Note on test ordering within a process:** retention runs once per process via
  `retentionDone`. Task 5's test calls `__resetRetentionForTests()` to re-trigger it
  deterministically regardless of which other tests flushed earlier in the same
  process.
