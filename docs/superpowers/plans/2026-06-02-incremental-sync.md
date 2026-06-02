# Incremental Sync (Concurrency + Freshness) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make memmem sync safe under concurrent runs (including racing plugin versions) and reflect mid-session work, with the minimum machinery.

**Architecture:** Add a fail-fast single-run lock (atomic `mkdir` beside the index dir, mtime-based stale reclamation, no PID-liveness) wrapping `runSyncCli()`; add a `Stop` hook so sync also runs at each turn end; set two WAL pragmas so a rare reader/writer overlap is safe instead of instant-fail. No new tables. File-skip is deferred until measured.

**Tech Stack:** Bun, bun:sqlite, TypeScript, `bun test`. Node `fs` for the lock.

**Spec:** `docs/superpowers/specs/2026-06-02-incremental-sync-design.md`

---

## File Structure

- **Create `src/core/lock.ts`** — single responsibility: acquire/release an advisory cross-process sync lock. Exposes one function `acquireSyncLock()`. Depends only on `fs`, `path`, `src/core/paths.ts` (`getIndexDir`), and `src/core/logger.ts`.
- **Create `src/core/lock.test.ts`** — unit tests for the lock.
- **Modify `src/cli/sync.ts`** — wire `acquireSyncLock()` into `runSyncCli()`.
- **Modify `src/core/db.ts`** — add two PRAGMA lines in `createDatabase()`.
- **Modify `src/core/db.test.ts`** — assert the two pragmas.
- **Modify `hooks/hooks.json`** — add a `Stop` hook entry.

**Lock path decision (refines spec):** the spec said `${getDbPath()}.lock`, but `getDbPath()` can be `:memory:` under tests, yielding a nonsensical `:memory:.lock`. Use `path.join(getIndexDir(), 'sync.lock')` instead. `getIndexDir()` always resolves to a real directory (`~/.config/memmem/conversation-index` or a test override) and is keyed on the shared config dir, NOT the plugin install path — so all installed versions still contend on the same lock. This preserves the multi-version-race fix.

---

## Task 1: Single-run lock module

**Files:**
- Create: `src/core/lock.ts`
- Test: `src/core/lock.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/lock.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { acquireSyncLock } from './lock.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'memmem-lock-'));
  // getIndexDir() reads from the config dir; CONVERSATION_MEMORY_CONFIG_DIR
  // overrides it. Point it at our temp dir so the lock lands there.
  process.env.CONVERSATION_MEMORY_CONFIG_DIR = dir;
});

afterEach(() => {
  delete process.env.CONVERSATION_MEMORY_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireSyncLock', () => {
  test('acquires when free and releases', () => {
    const release = acquireSyncLock();
    expect(release).not.toBeNull();
    release!();
    // After release, lock is acquirable again.
    const again = acquireSyncLock();
    expect(again).not.toBeNull();
    again!();
  });

  test('returns null when already held', () => {
    const first = acquireSyncLock();
    expect(first).not.toBeNull();
    const second = acquireSyncLock();
    expect(second).toBeNull();
    first!();
  });

  test('reclaims a stale lock (mtime older than ceiling)', () => {
    const first = acquireSyncLock();
    expect(first).not.toBeNull();
    // Age the lock dir well past the 30-minute ceiling.
    const lockPath = path.join(dir, 'conversation-index', 'sync.lock');
    const old = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(lockPath, old, old);
    // A fresh acquire sees EEXIST, finds it stale, reclaims it.
    const second = acquireSyncLock();
    expect(second).not.toBeNull();
    second!();
    // Do not call first!() — its dir was reclaimed; release must be safe anyway.
    first!();
  });

  test('release is safe even if lock dir already gone', () => {
    const release = acquireSyncLock();
    expect(release).not.toBeNull();
    const lockPath = path.join(dir, 'conversation-index', 'sync.lock');
    rmSync(lockPath, { recursive: true, force: true });
    expect(() => release!()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/lock.test.ts`
Expected: FAIL — `Cannot find module './lock.js'` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/core/lock.ts`:

```ts
import { mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { getIndexDir } from './paths.js';
import { log } from './logger.js';

/** A lock older than this is treated as abandoned by a crashed holder. */
const STALE_MS = 30 * 60 * 1000;

function lockPath(): string {
  return path.join(getIndexDir(), 'sync.lock');
}

function tryCreate(lockDir: string): boolean {
  try {
    mkdirSync(lockDir); // atomic; throws EEXIST if held
    // PID is written for diagnostics only — never used for liveness checks.
    writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

function isStale(lockDir: string): boolean {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Acquire the single-run sync lock.
 * Returns a release function, or null if another sync currently holds it.
 */
export function acquireSyncLock(): (() => void) | null {
  const lockDir = lockPath();

  if (tryCreate(lockDir)) {
    return makeRelease(lockDir);
  }

  // Held. Reclaim only if the holder looks crashed (stale by mtime age).
  if (isStale(lockDir)) {
    log.warn('Reclaiming stale sync lock', { lockDir });
    rmSync(lockDir, { recursive: true, force: true });
    if (tryCreate(lockDir)) {
      return makeRelease(lockDir);
    }
  }

  return null;
}

function makeRelease(lockDir: string): () => void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    rmSync(lockDir, { recursive: true, force: true });
  };
  // Release on interrupt so a Ctrl-C'd sync doesn't leave a lock behind.
  process.once('SIGINT', release);
  process.once('SIGTERM', release);
  return release;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/lock.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/lock.ts src/core/lock.test.ts
git commit -m "feat(sync): add single-run advisory lock"
```

---

## Task 2: Wire the lock into runSyncCli

**Files:**
- Modify: `src/cli/sync.ts` (imports + `runSyncCli` at lines 100-108)
- Test: `src/cli/sync.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/cli/sync.test.ts` (inside the existing top-level `describe`, or as a new `describe`). First check the existing imports at the top of that file; ensure `acquireSyncLock` is importable. Add:

```ts
import { acquireSyncLock } from '../core/lock.js';

describe('runSyncCli lock', () => {
  test('skips work when the lock is already held', async () => {
    // Hold the lock from "another process".
    const held = acquireSyncLock();
    expect(held).not.toBeNull();

    // runSyncCli must return without opening the DB / throwing.
    const { runSyncCli } = await import('./sync.js');
    await expect(runSyncCli()).resolves.toBeUndefined();

    held!();
  });
});
```

Note: this test relies on `CONVERSATION_MEMORY_CONFIG_DIR` / `TEST_DB_PATH` being set to a temp location by the existing sync test setup. If the existing file does not already isolate config dir, set `process.env.CONVERSATION_MEMORY_CONFIG_DIR` to a `mkdtempSync` dir in this describe's `beforeEach`/`afterEach`, mirroring `src/core/lock.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cli/sync.test.ts -t "skips work when the lock is already held"`
Expected: FAIL — `runSyncCli` currently ignores the lock and proceeds to open the DB (no early return).

- [ ] **Step 3: Write minimal implementation**

In `src/cli/sync.ts`, add the import near the other `../core/*` imports (after the `logger` import line):

```ts
import { acquireSyncLock } from '../core/lock.js';
```

Replace the existing `runSyncCli` (lines 100-108) with:

```ts
export async function runSyncCli(): Promise<void> {
  const release = acquireSyncLock();
  if (!release) {
    log.info('sync already running; skipping');
    return;
  }
  const db = openDatabase();
  try {
    const result = await syncTranscripts(db);
    log.info(`Done.`, { ...result });
  } finally {
    db.close();
    release();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cli/sync.test.ts`
Expected: PASS — the new test passes and all pre-existing sync tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/sync.ts src/cli/sync.test.ts
git commit -m "feat(sync): skip sync run when lock is held"
```

---

## Task 3: WAL safety pragmas

**Files:**
- Modify: `src/core/db.ts` (`createDatabase`, the block that runs `PRAGMA journal_mode = WAL`)
- Test: `src/core/db.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/core/db.test.ts` a new test. It uses the existing `openTestDatabase()` helper (sets `TEST_DB_PATH=:memory:` and calls `initDatabase()`); `initDatabase()` runs the same pragma block as `openDatabase()` via `createDatabase`. Pragmas apply to `:memory:` too.

```ts
test('sets WAL safety pragmas', () => {
  const database = openTestDatabase();
  const busy = database.query('PRAGMA busy_timeout').get() as { timeout: number };
  expect(busy.timeout).toBe(5000);
  const sync = database.query('PRAGMA synchronous').get() as { synchronous: number };
  expect(sync.synchronous).toBe(1); // 1 = NORMAL
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/db.test.ts -t "sets WAL safety pragmas"`
Expected: FAIL — `busy_timeout` is the default `0` (not 5000); `synchronous` is `2` (FULL) not `1`.

- [ ] **Step 3: Write minimal implementation**

In `src/core/db.ts`, find:

```ts
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
```

Add two lines immediately after the WAL line:

```ts
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/db.test.ts`
Expected: PASS — new pragma test passes, existing db tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/core/db.ts src/core/db.test.ts
git commit -m "feat(db): add busy_timeout and synchronous=NORMAL WAL pragmas"
```

---

## Task 4: Stop hook for mid-session freshness

**Files:**
- Modify: `hooks/hooks.json`

No unit test framework runs hooks.json; verification is structural (valid JSON, correct shape).

- [ ] **Step 1: Add the Stop hook**

Replace the entire contents of `hooks/hooks.json` with:

```json
{
  "$schema": "../../schemas/hooks-schema.json",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "sh ${CLAUDE_PLUGIN_ROOT}/hooks/run.sh sync",
            "async": true
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh ${CLAUDE_PLUGIN_ROOT}/hooks/run.sh sync",
            "async": true
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Verify it is valid JSON**

Run: `bun -e "JSON.parse(require('fs').readFileSync('hooks/hooks.json','utf8')); console.log('valid')"`
Expected: prints `valid`.

- [ ] **Step 3: Verify the Stop entry shape**

Run: `bun -e "const h=JSON.parse(require('fs').readFileSync('hooks/hooks.json','utf8')); const c=h.hooks.Stop[0].hooks[0].command; if(!/run\.sh sync/.test(c)) throw new Error('bad Stop command'); console.log('Stop hook ok')"`
Expected: prints `Stop hook ok`.

- [ ] **Step 4: Commit**

```bash
git add hooks/hooks.json
git commit -m "feat(hooks): run sync on Stop for mid-session freshness"
```

---

## Task 5: Full build + test gate

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: all tests pass, including the new `lock`, `sync`, and `db` tests.

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: build succeeds (CLI/MCP bundles emitted). `src/core/lock.ts` is bundled transitively via `sync.ts`; no external-deps change needed.

- [ ] **Step 4: Commit (only if build produced tracked artifact changes)**

```bash
git status --short
# If dist/ or other tracked build outputs changed and are normally committed, add them:
# git add dist && git commit -m "chore(build): rebuild after incremental-sync changes"
```

If `git status` shows no tracked changes, skip the commit.

---

## Self-Review

**1. Spec coverage:**
- Single-run lock (spec §Design.1) → Task 1 + Task 2. ✓ (lock path refined to `getIndexDir()/sync.lock` with documented rationale; multi-version race fix preserved via shared config dir.)
- Stop hook (spec §Design.2) → Task 4. ✓
- WAL pragmas `busy_timeout=5000` + `synchronous=NORMAL` (spec §Design.3) → Task 3. ✓
- Stale reclamation by mtime, no PID liveness (spec §Design.1) → Task 1 Step 3 (`isStale`) + test. ✓
- Release on interrupt (spec §Design.1) → Task 1 `makeRelease` SIGINT/SIGTERM. ✓
- No new tables → confirmed; no schema changes in any task. ✓
- File-skip deferred (spec §Deferred) → intentionally no task. ✓
- Testing strategy (spec §Testing): lock tests ✓, runSyncCli lock-held test ✓, db pragma test (busy_timeout=5000, synchronous=1) ✓.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"write tests for the above". Every code step shows complete code. ✓

**3. Type consistency:** `acquireSyncLock(): (() => void) | null` is defined in Task 1 and consumed identically in Task 2 (`const release = acquireSyncLock(); if (!release) ...; release()`). The release type `() => void` matches. `getIndexDir` imported from `./paths.js` exists (verified in paths.ts). `log.warn`/`log.info` exist (verified: `log` export in logger.ts). ✓

**Note for executor:** Task 2's test assumes the sync test file isolates the config dir. If it does not, add `CONVERSATION_MEMORY_CONFIG_DIR` setup/teardown in the new describe block (instructions inline in Task 2 Step 1).
