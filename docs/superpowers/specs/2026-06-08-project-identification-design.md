# Project Identification + Versioned Migration Framework

**Date:** 2026-06-08
**Status:** Approved (design)

## Problem

memmem's `memory_records.project` column is `null` for all 17,830+ active
records — both source adapters (`claude.ts`, `codex.ts`) hardcode `project:
null`. As a result, search/stats output cannot group records by project; the
same logical repository appears fragmented across git worktrees and across
sources (claude-projects vs codex-sessions).

We want each memory record to carry:

- **`project`** — a stable canonical identifier (e.g. `croquis/memmem`) that
  groups the same repo across worktrees and across Claude/Codex sources.
- **`project_name`** — a short, human-friendly display name (e.g. `memmem`).

Filling these columns requires a schema change (`project_name`) plus a one-time
data backfill of existing records. We also want a reusable, versioned
migration framework to manage this and future schema/data/filesystem changes —
the current approach (`migrateExtractionState` ad-hoc function in `db.ts`) does
not track applied state or order.

## Goals / Success Criteria

- search/stats results group the same logical repo together regardless of
  worktree or source_kind.
- Every active memory record has non-null `project` and `project_name`.
- New indexing fills both fields automatically.
- A versioned migration framework records applied state via `PRAGMA
  user_version` and applies pending migrations in order on `openDatabase()`.

## Part A — Versioned Migration Framework

### Layout

```
src/core/migrations/
  types.ts                 # Migration interface
  index.ts                 # MIGRATIONS registry + runMigrations(db)
  001-project-columns.ts   # first migration (Part B)
```

### Interface

```ts
interface Migration {
  version: number;        // 1, 2, 3 ... sequential, unique
  name: string;           // 'project-columns'
  up(db: Database): void; // SQL (DDL), JS backfill, or shell (execSync) — author's choice
}
```

- **Single `up(db)` method. No `down`/rollback.** `openDatabase()` always
  migrates forward to latest; mistakes are corrected with a new forward
  migration. (YAGNI — rollback is not needed for this tool's workflow.)
- The migration author decides transaction boundaries *inside* `up()`. A
  DB-only migration wraps its work in `db.transaction(fn)()`. A migration that
  also touches the filesystem (e.g. archive folder restructuring via
  `execSync`) keeps file changes outside the DB transaction and writes the
  author's own idempotency/ordering logic — because `db.transaction()` only
  rolls back DB state, never filesystem changes.

### Runner

```
runMigrations(db):
  current = db.query('PRAGMA user_version').get().user_version   // 0 on fresh DB
  for m of MIGRATIONS (ascending by version):
    if m.version > current:
      m.up(db)
      db.exec(`PRAGMA user_version = ${m.version}`)
```

- Called at the end of `createSchema()` inside `openDatabase()`.
- Idempotent: `user_version` gates re-application; applied migrations are no-ops
  on subsequent opens.
- The runner does **not** wrap `up()` in a transaction (so file+DB hybrids are
  expressible); it only advances `user_version` after `up()` returns.

### bun:sqlite specifics (verified via context7 + local check)

- `bun:sqlite` has **no `.pragma()` helper** (unlike better-sqlite3). Use
  `db.query('PRAGMA user_version').get()` to read and
  `db.exec('PRAGMA user_version = N')` to write.
- `db.transaction(fn)` commits on success, rolls back on throw. **The callback
  must be synchronous** — async callbacks may commit prematurely. Therefore
  `up()` and everything it calls (including `resolveProject`'s git access) must
  be synchronous (`execSync`, sync file reads). Do not mix manual BEGIN/COMMIT
  with `db.transaction()`.
- Local environment: SQLite 3.43.2 (DROP COLUMN supported, though unused since
  there is no rollback).

### Coexistence with existing `migrateExtractionState`

The existing `migrateExtractionState(db)` (adds `attempt_count` via
`ALTER TABLE ... ADD COLUMN`, guarded by `PRAGMA table_info`) is left in place
and untouched. The new registry starts at **version 1**. Already-deployed DBs
have `user_version = 0` but the `attempt_count` column already present; the
existing function remains idempotent and runs independently of the new runner.

## Part B — Project Identification

### `src/core/project.ts` (new)

```ts
resolveProject(cwd: string): { project: string; projectName: string }
```

Pure-ish function (git access injectable for tests):

1. **Worktree normalization:** strip `/.worktrees/<...>` and everything after,
   yielding `repoRoot`.
   - `/Users/jito.hello/dev/wooto/ssulmeta/.worktrees/00058-x`
     → `/Users/jito.hello/dev/wooto/ssulmeta`
2. **Hybrid resolution:**
   - If `repoRoot/.git` is accessible (directory or worktree `.git` file →
     `GIT_COMMON_DIR` → main config), read `remote "origin"` URL synchronously
     and parse to `org/repo`:
     - `https://github.com/org/repo.git` → `org/repo`
     - `git@github.com:org/repo.git` → `org/repo`
     - `project = "org/repo"`, `projectName = basename(repo)`
   - **Fallback** (git dir gone — common for archived/temporary worktrees, or no
     remote): use the **leaf segment only**, no org guessing.
     - `project = basename(repoRoot)`, `projectName = basename(repoRoot)`
     - Honest "org unknown" representation. The same repo seen later in a
       git-live session resolves to the precise `org/repo`; differing `project`
       values may coexist, but we never fabricate a wrong org from path guessing.
3. **Cache** the result keyed by `repoRoot` to avoid repeated git reads within a
   transcript.

Worktrees are transparent: both main and worktree cwds normalize to the same
`repoRoot`, share the same `.git/config`, and produce the same `project` /
`project_name`.

### Examples

| repoRoot | git live | fallback (git gone / no remote) |
|---|---|---|
| `~/dev/wooto/memmem` | `croquis/memmem` / `memmem` | `memmem` / `memmem` |
| `~/dev/search` | `croquis/search` / `search` | `search` / `search` |
| `/private/tmp` | (no remote → fallback) | `tmp` / `tmp` |

### Migration `001-project-columns.up(db)`

```
db.transaction(() => {
  if project_name column absent (PRAGMA table_info):
    ALTER TABLE memory_records ADD COLUMN project_name TEXT
  for each distinct archive_path among active records where project IS NULL:
    cwd = readCwdFromArchivedJsonl(archive_path)   // read the archived JSONL, extract cwd / payload.cwd
    { project, projectName } = resolveProject(cwd)
    UPDATE memory_records SET project = ?, project_name = ?
      WHERE archive_path = ? AND project IS NULL
})()
```

**Why read the JSONL, not decode the archive path:** the archive directory name
encodes cwd by replacing `/` with `-`, which is **not losslessly reversible**
when the original path contains `-` (e.g. `dev-search`,
`search--worktrees-...`). The archive is the source of truth and the JSONL file
is present at migration time, so reading `cwd` (Claude) / `payload.cwd` (Codex)
directly from the archived transcript is exact. Iterate per distinct
`archive_path` (not per record) since all records from one transcript share one
cwd — this also bounds the backfill to ~1.3k file reads rather than 17.8k.

- One-time backfill; `project IS NULL` guard makes re-runs no-ops.
- No embedding regeneration — only metadata columns change; text and vectors are
  untouched.
- Cost: ~17.8k UPDATEs in a single synchronous transaction on first
  `openDatabase()` after upgrade (seconds, embedding-independent).

### New indexing path

- The parsers **already extract `cwd` into the span** (`claude.ts` carries
  `cwd`; codex carries `payload.cwd`). The value is currently dropped when
  `project: null` is hardcoded on the way to the record. So no new parsing is
  needed — wire the existing `span.cwd` through.
- `indexer.ts` (lines ~232, ~271) calls `resolveProject(span.cwd)` and writes
  both `project` and `project_name` (replacing the `project: span.project`
  passthrough that is always null today).

## Components & Boundaries

- **`src/core/project.ts`** — `resolveProject`; worktree normalization + path
  parsing unit-tested without git; git branch tested with an injected reader.
- **`src/core/migrations/`** — framework (`types.ts`, `index.ts`) + migration
  modules. Single responsibility: track and apply versioned changes.
- **Source adapters** — supply `cwd` per span instead of `project: null`.
- **`indexer.ts`** — resolve and persist both fields during indexing.

## Testing (TDD)

- `resolveProject` unit tests: worktree path, main path, org present/absent,
  non-standard (`/private/tmp`), git remote parsing (https + ssh) via injected
  reader, fallback leaf-only behavior.
- Migration framework: in-memory DB, `user_version` advances, pending-only
  application, re-run no-op, transaction rollback on throw leaves
  `user_version` unchanged.
- `001-project-columns`: old-schema in-memory DB → run → `project_name` exists,
  records backfilled, data preserved, re-run no-op.
- indexer integration: span with cwd → both fields populated.

## Out of Scope (follow-up)

- MCP/CLI surfacing of `project_name` and project-grouped stats. `search`
  results already include `project`, so canonical grouping works immediately;
  display-name exposure and stats aggregation are separate.
