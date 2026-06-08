# Project Identification + Versioned Migration Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `memory_records.project` (canonical `org/repo`) and a new `project_name` (display) column so the same repo groups across worktrees and sources, delivered on top of a reusable versioned migration framework.

**Architecture:** A `resolveProject(cwd)` pure-ish helper normalizes worktree paths and resolves identity via git remote (synchronous) with a leaf-name fallback. A versioned migration registry keyed by `PRAGMA user_version` applies pending `up(db)` migrations on `openDatabase()`. The first migration adds `project_name` and backfills both columns by reading `cwd` from archived JSONL. The indexer wires the already-parsed `span.cwd` through `resolveProject` for new records.

**Tech Stack:** Bun, `bun:sqlite`, TypeScript, `bun test`. Git identity via `execSync('git ...')`.

---

## File Structure

- **Create** `src/core/project.ts` — `resolveProject(cwd, opts?)`: worktree normalization, git-remote resolution, leaf fallback. One responsibility: cwd → `{ project, projectName }`.
- **Create** `src/core/project.test.ts` — unit tests for `resolveProject`.
- **Create** `src/core/migrations/types.ts` — `Migration` interface.
- **Create** `src/core/migrations/index.ts` — `MIGRATIONS` registry + `runMigrations(db)`.
- **Create** `src/core/migrations/index.test.ts` — runner tests.
- **Create** `src/core/migrations/001-project-columns.ts` — first migration (schema + backfill).
- **Create** `src/core/migrations/001-project-columns.test.ts` — migration tests.
- **Modify** `src/core/db.ts` — add `projectName` to `MemoryRecordInsert` + `insertMemoryRecord` INSERT/UPDATE; call `runMigrations(db)` in `createSchema`.
- **Modify** `src/core/sources/codex.ts:38` — set `cwd: meta.cwd` instead of `null` on the span.
- **Modify** `src/core/indexer.ts:271` — resolve project from `span.cwd` and pass `project`/`projectName` to `insertMemoryRecord`.

---

## Task 1: `resolveProject` — worktree normalization + leaf fallback (no git)

**Files:**
- Create: `src/core/project.ts`
- Test: `src/core/project.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/project.test.ts
import { describe, expect, test } from 'bun:test';
import { resolveProject } from './project.js';

// gitReader returns null → forces the leaf fallback path
const noGit = { readRemoteOrgRepo: () => null };

describe('resolveProject (fallback, no git)', () => {
  test('strips worktree suffix and uses leaf segment', () => {
    const r = resolveProject(
      '/Users/jito.hello/dev/wooto/ssulmeta/.worktrees/00058-proud-harbor-bachman',
      { gitReader: noGit },
    );
    expect(r).toEqual({ project: 'ssulmeta', projectName: 'ssulmeta' });
  });

  test('plain repo path uses leaf segment', () => {
    const r = resolveProject('/Users/jito.hello/dev/search', { gitReader: noGit });
    expect(r).toEqual({ project: 'search', projectName: 'search' });
  });

  test('non-standard path uses leaf segment', () => {
    const r = resolveProject('/private/tmp', { gitReader: noGit });
    expect(r).toEqual({ project: 'tmp', projectName: 'tmp' });
  });

  test('null cwd yields unknown', () => {
    const r = resolveProject(null, { gitReader: noGit });
    expect(r).toEqual({ project: 'unknown', projectName: 'unknown' });
  });

  test('trailing slash is tolerated', () => {
    const r = resolveProject('/Users/jito.hello/dev/search/', { gitReader: noGit });
    expect(r).toEqual({ project: 'search', projectName: 'search' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/project.test.ts`
Expected: FAIL — `Cannot find module './project.js'` / `resolveProject is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/project.ts
export interface ProjectInfo {
  project: string;
  projectName: string;
}

export interface GitReader {
  // Returns "org/repo" if a git remote is resolvable for repoRoot, else null.
  readRemoteOrgRepo(repoRoot: string): string | null;
}

export interface ResolveProjectOptions {
  gitReader?: GitReader;
}

const UNKNOWN: ProjectInfo = { project: 'unknown', projectName: 'unknown' };

// Strip "/.worktrees/<...>" and everything after it.
export function normalizeRepoRoot(cwd: string): string {
  const marker = '/.worktrees/';
  const i = cwd.indexOf(marker);
  const root = i >= 0 ? cwd.slice(0, i) : cwd;
  return root.replace(/\/+$/, ''); // drop trailing slashes
}

function leaf(repoRoot: string): string {
  const parts = repoRoot.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'unknown';
}

export function resolveProject(
  cwd: string | null,
  opts: ResolveProjectOptions = {},
): ProjectInfo {
  if (!cwd) return UNKNOWN;
  const repoRoot = normalizeRepoRoot(cwd);
  if (!repoRoot) return UNKNOWN;

  const orgRepo = opts.gitReader?.readRemoteOrgRepo(repoRoot) ?? null;
  if (orgRepo) {
    const name = orgRepo.split('/').filter(Boolean).pop() ?? orgRepo;
    return { project: orgRepo, projectName: name };
  }

  const name = leaf(repoRoot);
  return { project: name, projectName: name };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/project.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/project.ts src/core/project.test.ts
git commit -m "feat(project): resolveProject worktree normalization + leaf fallback"
```

---

## Task 2: `resolveProject` — git remote resolution + URL parsing

**Files:**
- Modify: `src/core/project.ts`
- Test: `src/core/project.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/project.test.ts`:

```ts
import { parseOrgRepo } from './project.js';

describe('parseOrgRepo', () => {
  test('https url', () => {
    expect(parseOrgRepo('https://github.com/croquis/memmem.git')).toBe('croquis/memmem');
  });
  test('https url without .git', () => {
    expect(parseOrgRepo('https://github.com/croquis/memmem')).toBe('croquis/memmem');
  });
  test('ssh scp-like url', () => {
    expect(parseOrgRepo('git@github.com:croquis/memmem.git')).toBe('croquis/memmem');
  });
  test('ssh url with protocol', () => {
    expect(parseOrgRepo('ssh://git@github.com/croquis/memmem.git')).toBe('croquis/memmem');
  });
  test('trailing slash tolerated', () => {
    expect(parseOrgRepo('https://github.com/croquis/memmem/')).toBe('croquis/memmem');
  });
  test('unparseable returns null', () => {
    expect(parseOrgRepo('not-a-url')).toBeNull();
  });
});

describe('resolveProject (git remote wins)', () => {
  test('uses org/repo from gitReader, name is repo basename', () => {
    const gitReader = { readRemoteOrgRepo: () => 'croquis/memmem' };
    const r = resolveProject('/Users/jito.hello/dev/wooto/memmem', { gitReader });
    expect(r).toEqual({ project: 'croquis/memmem', projectName: 'memmem' });
  });

  test('worktree cwd still resolves via repoRoot git', () => {
    const seen: string[] = [];
    const gitReader = {
      readRemoteOrgRepo: (root: string) => {
        seen.push(root);
        return 'croquis/memmem';
      },
    };
    const r = resolveProject(
      '/Users/jito.hello/dev/wooto/memmem/.worktrees/00008-x',
      { gitReader },
    );
    expect(r).toEqual({ project: 'croquis/memmem', projectName: 'memmem' });
    expect(seen).toEqual(['/Users/jito.hello/dev/wooto/memmem']); // normalized root, not the worktree
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/project.test.ts`
Expected: FAIL — `parseOrgRepo is not a function` (the `resolveProject` git tests already pass from Task 1, but `parseOrgRepo` is not exported yet).

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/project.ts`:

```ts
// Parse a git remote URL to "org/repo", or null if not parseable.
export function parseOrgRepo(remoteUrl: string): string | null {
  let s = remoteUrl.trim();
  if (!s) return null;
  // scp-like: git@host:org/repo(.git)
  const scp = s.match(/^[^@]+@[^:]+:(.+)$/);
  if (scp) {
    s = scp[1];
  } else {
    // protocol urls: https://host/org/repo(.git), ssh://git@host/org/repo(.git)
    const proto = s.match(/^[a-z]+:\/\/[^/]+\/(.+)$/i);
    if (proto) s = proto[1];
    else if (s.includes('://') || s.includes('@')) return null;
    else if (!s.includes('/')) return null;
  }
  s = s.replace(/\.git$/, '').replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/project.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/project.ts src/core/project.test.ts
git commit -m "feat(project): parse git remote url to org/repo"
```

---

## Task 3: Default git reader (synchronous `execSync`)

**Files:**
- Modify: `src/core/project.ts`
- Test: `src/core/project.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/project.test.ts`:

```ts
import { defaultGitReader } from './project.js';

describe('defaultGitReader', () => {
  test('returns null for a non-existent path (no throw)', () => {
    expect(defaultGitReader.readRemoteOrgRepo('/no/such/path/xyz')).toBeNull();
  });

  test('reads this repo as a real org/repo or null, never throws', () => {
    const r = defaultGitReader.readRemoteOrgRepo(process.cwd());
    // In CI the remote may be absent; only assert shape.
    expect(r === null || /\S+\/\S+/.test(r)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/project.test.ts`
Expected: FAIL — `defaultGitReader is not exported`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/project.ts`:

```ts
import { execFileSync } from 'child_process';

export const defaultGitReader: GitReader = {
  readRemoteOrgRepo(repoRoot: string): string | null {
    try {
      const url = execFileSync(
        'git',
        ['-C', repoRoot, 'config', '--get', 'remote.origin.url'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (!url) return null;
      return parseOrgRepo(url);
    } catch {
      return null; // not a repo, git missing, no remote — all fall back
    }
  },
};
```

Then make `resolveProject` default to it:

```ts
// change the orgRepo line in resolveProject:
  const reader = opts.gitReader ?? defaultGitReader;
  const orgRepo = reader.readRemoteOrgRepo(repoRoot);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/project.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/project.ts src/core/project.test.ts
git commit -m "feat(project): default synchronous git reader via execFileSync"
```

---

## Task 4: Migration framework — types + runner

**Files:**
- Create: `src/core/migrations/types.ts`
- Create: `src/core/migrations/index.ts`
- Test: `src/core/migrations/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/migrations/index.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrationsWith } from './index.js';
import type { Migration } from './types.js';

function userVersion(db: Database): number {
  return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
}

describe('runMigrationsWith', () => {
  test('applies pending migrations in order and advances user_version', () => {
    const db = new Database(':memory:');
    const applied: number[] = [];
    const migs: Migration[] = [
      { version: 1, name: 'a', up: () => applied.push(1) },
      { version: 2, name: 'b', up: () => applied.push(2) },
    ];
    runMigrationsWith(db, migs);
    expect(applied).toEqual([1, 2]);
    expect(userVersion(db)).toBe(2);
    db.close();
  });

  test('skips already-applied migrations (re-run is no-op)', () => {
    const db = new Database(':memory:');
    const applied: number[] = [];
    const migs: Migration[] = [
      { version: 1, name: 'a', up: () => applied.push(1) },
      { version: 2, name: 'b', up: () => applied.push(2) },
    ];
    runMigrationsWith(db, migs);
    runMigrationsWith(db, migs); // second run
    expect(applied).toEqual([1, 2]); // not re-applied
    expect(userVersion(db)).toBe(2);
    db.close();
  });

  test('throwing migration stops progress and leaves user_version at last good', () => {
    const db = new Database(':memory:');
    const migs: Migration[] = [
      { version: 1, name: 'a', up: () => {} },
      { version: 2, name: 'boom', up: () => { throw new Error('boom'); } },
      { version: 3, name: 'c', up: () => {} },
    ];
    expect(() => runMigrationsWith(db, migs)).toThrow('boom');
    expect(userVersion(db)).toBe(1);
    db.close();
  });

  test('applies out-of-order registry entries by ascending version', () => {
    const db = new Database(':memory:');
    const applied: number[] = [];
    const migs: Migration[] = [
      { version: 2, name: 'b', up: () => applied.push(2) },
      { version: 1, name: 'a', up: () => applied.push(1) },
    ];
    runMigrationsWith(db, migs);
    expect(applied).toEqual([1, 2]);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/migrations/index.test.ts`
Expected: FAIL — `Cannot find module './index.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/migrations/types.ts
import type { Database } from 'bun:sqlite';

export interface Migration {
  version: number; // sequential, unique, >= 1
  name: string;
  // SQL (DDL), JS backfill, or shell (execSync) — author's choice.
  // Transaction boundaries are the author's responsibility inside up().
  up(db: Database): void;
}
```

```ts
// src/core/migrations/index.ts
import type { Database } from 'bun:sqlite';
import type { Migration } from './types.js';
import { projectColumnsMigration } from './001-project-columns.js';

// Ordered registry. New migrations append with the next version number.
export const MIGRATIONS: Migration[] = [projectColumnsMigration];

function getUserVersion(db: Database): number {
  return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
}

// Testable core: run a given list against a db.
export function runMigrationsWith(db: Database, migrations: Migration[]): void {
  const current = getUserVersion(db);
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => m.version > current);
  for (const m of pending) {
    m.up(db);
    // PRAGMA cannot be parameterized; version is a trusted integer.
    db.exec(`PRAGMA user_version = ${m.version}`);
  }
}

// Production entrypoint: run the real registry.
export function runMigrations(db: Database): void {
  runMigrationsWith(db, MIGRATIONS);
}
```

NOTE: `index.ts` imports `001-project-columns.js`, created in Task 5. Until then this file will not type-check on its own; that is expected and resolved by Task 5. The `index.test.ts` tests use `runMigrationsWith` with inline migrations and do not exercise the registry import at runtime, but the module still imports `001-project-columns`. To keep Task 4 independently green, create a minimal stub now and replace it in Task 5:

```ts
// src/core/migrations/001-project-columns.ts  (STUB — replaced in Task 5)
import type { Migration } from './types.js';
export const projectColumnsMigration: Migration = {
  version: 1,
  name: 'project-columns',
  up: () => {},
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/migrations/index.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/migrations/types.ts src/core/migrations/index.ts src/core/migrations/001-project-columns.ts
git commit -m "feat(migrations): versioned migration registry + runner"
```

---

## Task 5: `db.ts` — `project_name` column on insert path + wire runner

**Files:**
- Modify: `src/core/db.ts` (`MemoryRecordInsert` ~line 32; `insertMemoryRecord` ~lines 200-244; `createSchema` ~line 180)
- Test: `src/core/migrations/001-project-columns.test.ts` (created in Task 6 — this task only changes db.ts + adds the column-aware insert; covered by an inline test here)
- Test: `src/core/db.project-name.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/db.project-name.test.ts
import { describe, expect, test } from 'bun:test';
import { initDatabase, insertMemoryRecord } from './db.js';

describe('insertMemoryRecord persists project_name', () => {
  test('stores and returns project + project_name', () => {
    const db = initDatabase(); // test-only: wipes & recreates :memory: or temp
    const id = insertMemoryRecord(db, {
      kind: 'fact',
      text: 'hello',
      sourceKind: 'claude-projects',
      archivePath: '/a/b.jsonl',
      lineStart: 1,
      lineEnd: 2,
      observedAt: null,
      project: 'croquis/memmem',
      projectName: 'memmem',
      dedupeKey: 'k1',
      extractionVersion: 1,
    });
    const row = db
      .query('SELECT project, project_name AS projectName FROM memory_records WHERE id = ?')
      .get(id) as { project: string; projectName: string };
    expect(row).toEqual({ project: 'croquis/memmem', projectName: 'memmem' });
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/db.project-name.test.ts`
Expected: FAIL — `projectName` not accepted / `project_name` column missing or not written.

- [ ] **Step 3: Write minimal implementation**

3a. Add `projectName` to the `MemoryRecordInsert` interface (after `project`, ~line 32):

```ts
  project: string | null;
  projectName: string | null;
```

3b. Ensure the base schema includes `project_name`. In `createSchema`, the `CREATE TABLE memory_records` body — add the column after `project TEXT,` (~line 132):

```sql
      project TEXT,
      project_name TEXT,
```

3c. Update `insertMemoryRecord` INSERT to include the column (add `project_name` to the column list, one more `?`, and the `excluded` update):

```ts
  db.query(`
    INSERT INTO memory_records (
      kind, text, source_kind, archive_path, line_start, line_end,
      observed_at, project, project_name, confidence, status, supersedes_id,
      dedupe_key, extraction_version, embedding_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key, archive_path, line_start, line_end) DO UPDATE SET
      kind = excluded.kind,
      text = excluded.text,
      source_kind = excluded.source_kind,
      observed_at = excluded.observed_at,
      project = excluded.project,
      project_name = excluded.project_name,
      confidence = excluded.confidence,
      status = excluded.status,
      supersedes_id = excluded.supersedes_id,
      extraction_version = excluded.extraction_version,
      embedding_version = excluded.embedding_version,
      updated_at = excluded.updated_at
  `).run(
    record.kind,
    record.text,
    record.sourceKind,
    record.archivePath,
    record.lineStart,
    record.lineEnd,
    record.observedAt,
    record.project,
    record.projectName,
    record.confidence ?? 1.0,
    record.status ?? 'active',
    record.supersedesId ?? null,
    record.dedupeKey,
    record.extractionVersion,
    record.embeddingVersion ?? null,
    now,
    now,
  );
```

3d. Wire the runner. In `createSchema`, add the import at the top of `db.ts`:

```ts
import { runMigrations } from './migrations/index.js';
```

And at the end of `createSchema` (right after `migrateExtractionState(db);` at ~line 180):

```ts
  migrateExtractionState(db);
  runMigrations(db);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/db.project-name.test.ts && bun run typecheck`
Expected: PASS; typecheck clean. (Existing callers of `insertMemoryRecord` will now fail typecheck because `projectName` is required — fixed in Task 7. If typecheck flags `indexer.ts`, that is expected and addressed in Task 7. To keep this task green, temporarily ensure indexer passes `projectName: null`; Task 7 replaces it with the resolved value.)

3e. Bridge change in `indexer.ts:271` to keep typecheck green now (replaced properly in Task 7):

```ts
            project: span.project,
            projectName: null,
```

- [ ] **Step 5: Commit**

```bash
git add src/core/db.ts src/core/db.project-name.test.ts src/core/indexer.ts
git commit -m "feat(db): project_name column on memory_records + wire migration runner"
```

---

## Task 6: Migration `001-project-columns` — backfill from archived JSONL

**Files:**
- Modify: `src/core/migrations/001-project-columns.ts` (replace the Task 4 stub)
- Test: `src/core/migrations/001-project-columns.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/migrations/001-project-columns.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { projectColumnsMigration } from './001-project-columns.js';

// Build a pre-migration memory_records table WITHOUT project_name and with project NULL.
function oldDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memory_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      project TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);
  return db;
}

test('adds project_name column and backfills from archived JSONL cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memmem-mig-'));
  // Claude-style archived transcript carrying cwd
  const claudePath = join(dir, 'claude.jsonl');
  writeFileSync(
    claudePath,
    [
      JSON.stringify({ type: 'summary' }),
      JSON.stringify({ type: 'user', cwd: '/Users/me/dev/acme/widget/.worktrees/00001-x', message: {} }),
    ].join('\n'),
  );
  // Codex-style archived transcript carrying payload.cwd
  const codexPath = join(dir, 'codex.jsonl');
  writeFileSync(
    codexPath,
    [
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/me/dev/acme/gadget' } }),
    ].join('\n'),
  );

  const db = oldDb();
  const ins = db.prepare(
    'INSERT INTO memory_records (kind, text, source_kind, archive_path, line_start, line_end, project, status) VALUES (?,?,?,?,?,?,?,?)',
  );
  ins.run('fact', 't1', 'claude-projects', claudePath, 1, 2, null, 'active');
  ins.run('fact', 't2', 'claude-projects', claudePath, 3, 4, null, 'active'); // same transcript
  ins.run('fact', 't3', 'codex-sessions', codexPath, 1, 1, null, 'active');

  // Force fallback (no real git for temp dirs) by injecting a null reader via env-free path:
  // the migration uses resolveProject's default reader; temp dirs are not git repos → leaf fallback.
  projectColumnsMigration.up(db);

  const rows = db
    .query('SELECT archive_path AS p, project, project_name AS pn FROM memory_records ORDER BY id')
    .all() as Array<{ p: string; project: string; pn: string }>;

  // worktree normalized → leaf 'widget'; codex → 'gadget'
  expect(rows[0]).toMatchObject({ project: 'widget', pn: 'widget' });
  expect(rows[1]).toMatchObject({ project: 'widget', pn: 'widget' });
  expect(rows[2]).toMatchObject({ project: 'gadget', pn: 'gadget' });

  // idempotent: re-run does not change values and does not throw
  projectColumnsMigration.up(db);
  const again = db
    .query('SELECT project FROM memory_records ORDER BY id')
    .all() as Array<{ project: string }>;
  expect(again.map((r) => r.project)).toEqual(['widget', 'widget', 'gadget']);

  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/migrations/001-project-columns.test.ts`
Expected: FAIL — stub does nothing; `project_name` column missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/migrations/001-project-columns.ts
import type { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import type { Migration } from './types.js';
import { resolveProject } from '../project.js';

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

// Extract the first cwd found in an archived transcript:
// Claude lines carry top-level `cwd`; Codex lines carry `payload.cwd`.
function readCwdFromArchive(archivePath: string): string | null {
  let content: string;
  try {
    content = readFileSync(archivePath, 'utf8');
  } catch {
    return null; // archive missing → resolveProject(null) yields 'unknown'
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } };
      const cwd = typeof obj.cwd === 'string' ? obj.cwd
        : typeof obj.payload?.cwd === 'string' ? obj.payload.cwd
        : null;
      if (cwd) return cwd;
    } catch {
      // skip malformed line
    }
  }
  return null;
}

export const projectColumnsMigration: Migration = {
  version: 1,
  name: 'project-columns',
  up(db: Database): void {
    const run = db.transaction(() => {
      if (!hasColumn(db, 'memory_records', 'project_name')) {
        db.exec('ALTER TABLE memory_records ADD COLUMN project_name TEXT');
      }

      // Distinct archive_paths still needing backfill (project IS NULL).
      const paths = db
        .query(
          `SELECT DISTINCT archive_path AS p FROM memory_records
           WHERE status = 'active' AND project IS NULL`,
        )
        .all() as Array<{ p: string }>;

      const update = db.prepare(
        `UPDATE memory_records SET project = ?, project_name = ?
         WHERE archive_path = ? AND project IS NULL`,
      );

      for (const { p } of paths) {
        const cwd = readCwdFromArchive(p);
        const { project, projectName } = resolveProject(cwd);
        update.run(project, projectName, p);
      }
    });
    run();
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/migrations/001-project-columns.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/migrations/001-project-columns.ts src/core/migrations/001-project-columns.test.ts
git commit -m "feat(migrations): 001 add project_name + backfill from archived cwd"
```

---

## Task 7: Wire new indexing path (claude already has cwd; codex needs wiring)

**Files:**
- Modify: `src/core/sources/codex.ts:38` (span `cwd: null` → `cwd: meta.cwd`)
- Modify: `src/core/indexer.ts:271` (resolve and pass project/projectName)
- Test: `src/core/sources/codex.test.ts` (extend), `src/core/indexer.project.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/indexer.project.test.ts
import { describe, expect, test } from 'bun:test';
import { resolveProject } from './project.js';

// Guards the indexer contract: a span.cwd must map to project/projectName
// via resolveProject. (Indexer wiring is exercised indirectly; this locks the
// mapping the indexer relies on.)
test('indexer maps span cwd to project via resolveProject (fallback)', () => {
  const noGit = { readRemoteOrgRepo: () => null };
  const info = resolveProject('/Users/me/dev/acme/gadget', { gitReader: noGit });
  expect(info).toEqual({ project: 'gadget', projectName: 'gadget' });
});
```

Extend `src/core/sources/codex.test.ts` — find the existing span assertion (currently expects `cwd: null`) and add a case asserting cwd flows through. Add this test:

```ts
test('codex span carries cwd from session_meta payload', () => {
  const jsonl = [
    JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/Users/me/dev/acme/gadget' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] } }),
  ].join('\n');
  const spans = parseCodexJsonl(jsonl, { archivePath: '/archive/codex-sessions/s1.jsonl', sourceKind: 'codex-sessions' });
  expect(spans[0]?.cwd).toBe('/Users/me/dev/acme/gadget');
});
```

(If the codex test file imports the parser under a different name, match the existing import in that file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/sources/codex.test.ts src/core/indexer.project.test.ts`
Expected: codex test FAILs (`cwd` is `null`); indexer mapping test PASSES (resolveProject already exists).

- [ ] **Step 3: Write minimal implementation**

3a. `src/core/sources/codex.ts` — in the span push (~line 38), change:

```ts
        project: null,
        cwd: meta.cwd,
        gitBranch: meta.gitBranch,
```

(`meta.cwd` and `meta.gitBranch` are already populated from `session_meta`/`turn_context`.)

3b. `src/core/indexer.ts` — add import at top:

```ts
import { resolveProject } from './project.js';
```

3c. `src/core/indexer.ts:271` — replace the bridge from Task 5 (`projectName: null`) with the resolved values. Compute once per span just before `insertMemoryRecord`:

```ts
        const { project, projectName } = resolveProject(span.cwd);
        for (const { record, embedding } of preparedRecords) {
          const memoryRecordId = insertMemoryRecord(db, {
            kind: record.kind,
            text: record.text,
            sourceKind: span.sourceKind,
            archivePath: span.archivePath,
            lineStart: span.lineStart,
            lineEnd: span.lineEnd,
            observedAt: span.observedAt,
            project,
            projectName,
            confidence: record.confidence,
            dedupeKey: record.dedupeKey ?? makeDedupeKey(record.kind, record.text),
            extractionVersion: CURRENT_EXTRACTION_VERSION,
            embeddingVersion: CURRENT_EMBEDDING_VERSION,
          });
          insertMemoryRecordVector(db, memoryRecordId, embedding);
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/sources/codex.test.ts src/core/indexer.project.test.ts && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/sources/codex.ts src/core/indexer.ts src/core/sources/codex.test.ts src/core/indexer.project.test.ts
git commit -m "feat(indexer): resolve project/project_name from span cwd; codex carries cwd"
```

---

## Task 8: Full suite, build, and verify on real DB

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS (all existing + new tests). If any existing test constructs `insertMemoryRecord` without `projectName`, update it to pass `projectName: null` (search: `insertMemoryRecord(`).

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: builds `dist/` without error.

- [ ] **Step 4: Verify migration on the real database (backup first)**

```bash
cp ~/.config/memmem/conversation-index/conversations.db /tmp/memmem-backup.db
bun run cli stats
```

Then confirm backfill populated project columns:

```bash
bun -e '
import { openDatabase } from "./src/core/db.js";
const db = openDatabase(); // triggers runMigrations → 001 backfill
const total = db.query("SELECT count(*) AS c FROM memory_records WHERE status=\"active\"").get();
const filled = db.query("SELECT count(*) AS c FROM memory_records WHERE status=\"active\" AND project IS NOT NULL").get();
const sample = db.query("SELECT project, project_name, count(*) AS c FROM memory_records WHERE status=\"active\" GROUP BY project ORDER BY c DESC LIMIT 12").all();
console.log("active:", total.c, "| project filled:", filled.c);
for (const r of sample) console.log(`  ${String(r.c).padStart(5)}  ${r.project}  (${r.project_name})`);
db.close();
'
```

Expected: `project filled` equals `active` (every active record backfilled). Sample shows `org/repo` for repos with a reachable git remote and leaf names for the rest; no `.worktrees` fragments; claude+codex of the same repo share a project value where git resolved it.

- [ ] **Step 5: Verify doctor still healthy**

Run: `bun run cli doctor`
Expected: `index ✓`, `data ✓` (project columns do not affect integrity checks).

- [ ] **Step 6: Commit (if any test fixups were needed)**

```bash
git add -A
git commit -m "test: project_name fixups across insertMemoryRecord callers"
```

---

## Self-Review Notes

- **Spec coverage:** Part A framework → Tasks 4, 5(wiring). Part B `resolveProject` (worktree norm, hybrid git, leaf fallback) → Tasks 1-3. `001-project-columns` schema + JSONL-cwd backfill → Task 6. New indexing path (claude has cwd, codex wiring) → Task 7. bun:sqlite pragma read/write & synchronous transaction → Tasks 4, 6. Coexistence with `migrateExtractionState` (registry starts v1, function untouched) → Task 5 step 3d. Backfill cost / read-per-transcript → Task 6 (distinct archive_path loop).
- **Type consistency:** `ProjectInfo` `{ project, projectName }`, `GitReader.readRemoteOrgRepo(repoRoot)`, `Migration` `{ version, name, up }`, `runMigrationsWith`/`runMigrations`, `MemoryRecordInsert.projectName: string | null` — used consistently across tasks.
- **No rollback** per design — registry has no `down`; confirmed throughout.
- **Known ordering dependency:** Task 5 makes `projectName` required on `MemoryRecordInsert`; Task 5 step 3e adds a temporary `projectName: null` bridge in `indexer.ts` so typecheck stays green, replaced with resolved values in Task 7. Other test callers fixed in Task 8 step 1.
