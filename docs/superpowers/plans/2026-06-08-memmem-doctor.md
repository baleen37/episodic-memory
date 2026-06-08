# memmem doctor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `memmem doctor` command that diagnoses build freshness, index integrity, and data health, printing suggested fix commands without auto-running them, plus a `doctor` skill.

**Architecture:** Pure diagnostics function in `src/core/doctor.ts` returns `DiagnosticResult[]`, reusing `verifyMemoryIndex` and `getMemoryStats`. A thin CLI wrapper in `src/cli/doctor.ts` resolves paths, prints a report, and sets the exit code. The router in `src/cli/main.ts` registers the command. A guide-only `skills/doctor/SKILL.md` drives the user-facing flow.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bun test`.

---

## File Structure

- Create `src/core/doctor.ts` — diagnostics logic (`DiagnosticResult`, `runDiagnostics`, `newestMtime`).
- Create `src/core/doctor.test.ts` — unit tests for diagnostics + mtime logic.
- Create `src/cli/doctor.ts` — `runDoctorCli()` report printer.
- Modify `src/cli/main.ts` — register `doctor` in switch + help text.
- Create `skills/doctor/SKILL.md` — guide for invoking and interpreting `memmem doctor`.

---

## Task 1: Core diagnostics module

**Files:**
- Create: `src/core/doctor.ts`
- Test: `src/core/doctor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/doctor.test.ts`:

```typescript
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CURRENT_EXTRACTION_VERSION, initDatabase, insertMemoryRecord, insertMemoryRecordVector } from './db.js';
import { runDiagnostics, newestMtime } from './doctor.js';

let db: Database | null = null;
let dir: string | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  delete process.env.TEST_DB_PATH;
});

function setMtime(path: string, epochSeconds: number): void {
  utimesSync(path, epochSeconds, epochSeconds);
}

describe('newestMtime', () => {
  test('returns the max mtime across .ts files, ignoring other extensions', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-doctor-mtime-'));
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    const other = join(dir, 'note.md');
    writeFileSync(a, '');
    writeFileSync(b, '');
    writeFileSync(other, '');
    setMtime(a, 1000);
    setMtime(b, 2000);
    setMtime(other, 9000);

    expect(newestMtime(dir, '.ts')).toBe(2000_000);
  });

  test('recurses into subdirectories', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-doctor-mtime-'));
    const sub = join(dir, 'core');
    rmSync(sub, { recursive: true, force: true });
    writeFileSync(join(dir, 'top.ts'), '');
    setMtime(join(dir, 'top.ts'), 1000);
    const nested = join(dir, 'nested');
    require('fs').mkdirSync(nested);
    writeFileSync(join(nested, 'deep.ts'), '');
    setMtime(join(nested, 'deep.ts'), 3000);

    expect(newestMtime(dir, '.ts')).toBe(3000_000);
  });
});

describe('runDiagnostics', () => {
  function freshBuildDirs(): { distDir: string; srcDir: string } {
    const distDir = join(dir!, 'dist');
    const srcDir = join(dir!, 'src');
    require('fs').mkdirSync(distDir, { recursive: true });
    require('fs').mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'main.ts'), '');
    setMtime(join(srcDir, 'main.ts'), 1000);
    writeFileSync(join(distDir, 'cli-internal.mjs'), '');
    writeFileSync(join(distDir, 'mcp-server.mjs'), '');
    setMtime(join(distDir, 'cli-internal.mjs'), 2000);
    setMtime(join(distDir, 'mcp-server.mjs'), 2000);
    return { distDir, srcDir };
  }

  test('all ok when build fresh and index clean with data', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-doctor-'));
    const archivePath = join(dir, 'archive.jsonl');
    writeFileSync(archivePath, 'line 1\nline 2\n');
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    const id = insertMemoryRecord(db, {
      kind: 'fact',
      text: 'A clean record.',
      sourceKind: 'claude-projects',
      archivePath,
      lineStart: 1,
      lineEnd: 2,
      observedAt: null,
      project: null,
      dedupeKey: 'fact:clean',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
    });
    insertMemoryRecordVector(db, id, new Array(384).fill(0));

    const results = runDiagnostics(db, freshBuildDirs());
    const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));

    expect(byName['build']).toBe('ok');
    expect(byName['index']).toBe('ok');
    expect(byName['data']).toBe('ok');
  });

  test('build fail when a dist artifact is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-doctor-'));
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    const distDir = join(dir, 'dist');
    const srcDir = join(dir, 'src');
    require('fs').mkdirSync(distDir, { recursive: true });
    require('fs').mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'main.ts'), '');
    // only one of the two required artifacts present
    writeFileSync(join(distDir, 'cli-internal.mjs'), '');

    const results = runDiagnostics(db, { distDir, srcDir });
    const build = results.find((r) => r.name === 'build')!;
    expect(build.status).toBe('fail');
    expect(build.suggestion).toBe('bun run build');
  });

  test('build fail when src newer than dist', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-doctor-'));
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    const distDir = join(dir, 'dist');
    const srcDir = join(dir, 'src');
    require('fs').mkdirSync(distDir, { recursive: true });
    require('fs').mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(distDir, 'cli-internal.mjs'), '');
    writeFileSync(join(distDir, 'mcp-server.mjs'), '');
    setMtime(join(distDir, 'cli-internal.mjs'), 1000);
    setMtime(join(distDir, 'mcp-server.mjs'), 1000);
    writeFileSync(join(srcDir, 'main.ts'), '');
    setMtime(join(srcDir, 'main.ts'), 5000);

    const results = runDiagnostics(db, { distDir, srcDir });
    expect(results.find((r) => r.name === 'build')!.status).toBe('fail');
  });

  test('data warn when no records', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-doctor-'));
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();

    const results = runDiagnostics(db, freshBuildDirs());
    const data = results.find((r) => r.name === 'data')!;
    expect(data.status).toBe('warn');
    expect(data.suggestion).toBe('memmem sync');
  });

  test('index fail when active record missing its vector', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-doctor-'));
    const archivePath = join(dir, 'archive.jsonl');
    writeFileSync(archivePath, 'line 1\nline 2\n');
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    insertMemoryRecord(db, {
      kind: 'fact',
      text: 'Record without a vector.',
      sourceKind: 'claude-projects',
      archivePath,
      lineStart: 1,
      lineEnd: 2,
      observedAt: null,
      project: null,
      dedupeKey: 'fact:novector',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
    });

    const results = runDiagnostics(db, freshBuildDirs());
    expect(results.find((r) => r.name === 'index')!.status).toBe('fail');
    expect(results.find((r) => r.name === 'data')!.status).toBe('warn');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/doctor.test.ts`
Expected: FAIL — `Cannot find module './doctor.js'` / `runDiagnostics is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/doctor.ts`:

```typescript
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { verifyMemoryIndex } from './verify.js';
import { getMemoryStats } from './stats.js';

export type DiagnosticStatus = 'ok' | 'warn' | 'fail';

export interface DiagnosticResult {
  name: string;
  status: DiagnosticStatus;
  detail: string;
  suggestion?: string;
}

export interface DiagnosticPaths {
  distDir: string;
  srcDir: string;
}

const REQUIRED_DIST_ARTIFACTS = ['cli-internal.mjs', 'mcp-server.mjs'];

/** Newest mtime (ms epoch) across files with `ext` under `dir`, recursive. 0 if none. */
export function newestMtime(dir: string, ext: string): number {
  let newest = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full, ext));
    } else if (entry.name.endsWith(ext)) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

function checkBuild(paths: DiagnosticPaths): DiagnosticResult {
  const missing = REQUIRED_DIST_ARTIFACTS.filter(
    (name) => !existsSync(join(paths.distDir, name)),
  );
  if (missing.length > 0) {
    return {
      name: 'build',
      status: 'fail',
      detail: `Missing build artifact(s): ${missing.join(', ')}.`,
      suggestion: 'bun run build',
    };
  }

  const srcMtime = newestMtime(paths.srcDir, '.ts');
  const distMtime = Math.min(
    ...REQUIRED_DIST_ARTIFACTS.map((name) => statSync(join(paths.distDir, name)).mtimeMs),
  );
  if (srcMtime > distMtime) {
    return {
      name: 'build',
      status: 'fail',
      detail: 'Source changed after the last build (dist is stale).',
      suggestion: 'bun run build',
    };
  }

  return { name: 'build', status: 'ok', detail: 'Build artifacts are up to date.' };
}

function checkIndex(db: Database): DiagnosticResult {
  const v = verifyMemoryIndex(db);
  const hard =
    v.missingArchives.length +
    v.invalidProvenance.length +
    v.missingVectors.length +
    v.orphanVectors.length;

  if (hard > 0) {
    return {
      name: 'index',
      status: 'fail',
      detail:
        `Integrity issues: ${v.missingArchives.length} missing archives, ` +
        `${v.invalidProvenance.length} invalid provenance, ` +
        `${v.missingVectors.length} missing vectors, ` +
        `${v.orphanVectors.length} orphan vectors.`,
      suggestion: 'memmem sync',
    };
  }

  if (v.retryableExtractionErrors.length > 0) {
    return {
      name: 'index',
      status: 'warn',
      detail: `${v.retryableExtractionErrors.length} retryable extraction error(s).`,
      suggestion: 'memmem sync',
    };
  }

  return { name: 'index', status: 'ok', detail: 'Memory index integrity verified.' };
}

function checkData(db: Database): DiagnosticResult {
  const s = getMemoryStats(db);
  if (s.activeMemoryRecords === 0) {
    return {
      name: 'data',
      status: 'warn',
      detail: 'No active memory records — nothing has been indexed yet.',
      suggestion: 'memmem sync',
    };
  }
  if (s.missingVectors > 0) {
    return {
      name: 'data',
      status: 'warn',
      detail: `${s.missingVectors} active record(s) are not vectorized.`,
      suggestion: 'memmem sync',
    };
  }
  return {
    name: 'data',
    status: 'ok',
    detail: `${s.activeMemoryRecords} active records, all vectorized.`,
  };
}

export function runDiagnostics(db: Database, paths: DiagnosticPaths): DiagnosticResult[] {
  return [checkBuild(paths), checkIndex(db), checkData(db)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/doctor.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/core/doctor.ts src/core/doctor.test.ts
git commit -m "feat(doctor): core diagnostics for build/index/data health"
```

---

## Task 2: CLI command

**Files:**
- Create: `src/cli/doctor.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: Write the CLI report printer**

Create `src/cli/doctor.ts`:

```typescript
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from '../core/db.js';
import { runDiagnostics, type DiagnosticStatus } from '../core/doctor.js';

const STATUS_ICON: Record<DiagnosticStatus, string> = {
  ok: '✓',
  warn: '⚠',
  fail: '✗',
};

/** Resolve the package root from this module's location (src/cli or dist). */
function resolveRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/cli/doctor.ts -> ../..  ;  dist/cli-internal.mjs -> ..
  return here.endsWith('cli') ? join(here, '..', '..') : join(here, '..');
}

export function runDoctorCli(): void {
  const db = openDatabase();
  try {
    const root = resolveRoot();
    const results = runDiagnostics(db, {
      distDir: join(root, 'dist'),
      srcDir: join(root, 'src'),
    });

    let hasFail = false;
    for (const r of results) {
      console.log(`${STATUS_ICON[r.status]} ${r.name}: ${r.detail}`);
      if (r.suggestion) {
        console.log(`    → run: ${r.suggestion}`);
      }
      if (r.status === 'fail') hasFail = true;
    }

    if (hasFail) {
      process.exitCode = 1;
    } else {
      console.log('\nmemmem is healthy.');
    }
  } finally {
    db.close();
  }
}
```

- [ ] **Step 2: Register the command in the router**

In `src/cli/main.ts`, add the import after the existing `runReadCli` import (line 1):

```typescript
import { runDoctorCli } from './doctor.js';
```

In the `switch (command)` block, add a case before `default:` (after the `verify` case at line 161-163):

```typescript
    case 'doctor':
      runDoctorCli();
      break;
```

In `getHelpText()`, add to the `COMMANDS:` list after the `verify` line:

```
  doctor    Diagnose build, index, and data health
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Build and run against the real environment**

Run: `bun run build && bun run cli doctor`
Expected: three lines (`build`, `index`, `data`) each prefixed with `✓`/`⚠`/`✗`. On this dev machine, `build` should be `✓` immediately after building.

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor.ts src/cli/main.ts
git commit -m "feat(doctor): add memmem doctor CLI command"
```

---

## Task 3: doctor skill

**Files:**
- Create: `skills/doctor/SKILL.md`

- [ ] **Step 1: Write the skill**

Create `skills/doctor/SKILL.md`:

```markdown
---
name: doctor
description: Diagnose the health of the memmem plugin. Invoke when memmem search returns nothing, after upgrades, or when the user asks to check that memmem is working.
version: 1.0.0
---

# Diagnose Conversation Memory

This skill checks whether the memmem plugin is healthy and tells the user how to
fix anything that is wrong. It diagnoses and suggests — it never auto-runs a fix.

## Run the diagnostic

```bash
memmem doctor
```

Each line reports one check:

- `✓ <check>` — healthy, nothing to do.
- `⚠ <check>` — degraded but usable; a suggested command can improve it.
- `✗ <check>` — broken; run the suggested command to fix it.

Checks:

| Check | Meaning | Typical fix |
|-------|---------|-------------|
| `build` | `dist/` is rebuilt after the latest `src` change | `bun run build` |
| `index` | Memory index passes integrity verification | `memmem sync` |
| `data`  | Records exist and are vectorized | `memmem sync` |

The exit code is `1` if any check is `✗`, otherwise `0`.

## Acting on the result

When a check reports `⚠` or `✗`, the output prints a suggested command
(`→ run: ...`). **Show the suggestion to the user and run it only after they
approve.** Do not run fixes automatically.

After running a suggested fix, re-run `memmem doctor` to confirm the check now
reports `✓`.

## Related

- [skills/setup/SKILL.md](../setup/SKILL.md) — configure the LLM provider and
  environment (run this if `data` stays empty after `memmem sync`, since
  extraction needs a configured provider).
```

- [ ] **Step 2: Verify skill frontmatter loads**

Run: `head -5 skills/doctor/SKILL.md`
Expected: valid YAML frontmatter with `name: doctor`.

- [ ] **Step 3: Commit**

```bash
git add skills/doctor/SKILL.md
git commit -m "feat(doctor): add doctor skill"
```

---

## Task 4: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: all tests pass, including `src/core/doctor.test.ts`.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Build and smoke-test**

Run: `bun run build && bun run cli doctor && echo "exit=$?"`
Expected: a three-line report; `exit=0` if healthy.

---

## Self-Review Notes

- **Spec coverage:** build/index/data checks (Task 1) match the spec table; CLI
  diagnose+suggest, exit code, no auto-run (Task 2); skill guide (Task 3). All
  three spec checks have tasks.
- **Type consistency:** `DiagnosticResult`/`DiagnosticStatus`/`runDiagnostics`/
  `newestMtime`/`DiagnosticPaths` names are used identically in core, test, and
  CLI.
- **Note on `data` vs `index` missing-vector overlap:** intentional per spec —
  a record without a vector makes `index` `fail` (broken join) and `data` `warn`
  (needs sync). Both fire; test `index fail when active record missing its
  vector` asserts exactly this.
```
