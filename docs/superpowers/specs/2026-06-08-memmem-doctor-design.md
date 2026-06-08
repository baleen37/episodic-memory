# memmem doctor — Design

## Purpose

`memmem doctor` is a single-command health diagnostic for the memmem plugin. It
answers the question "is my memmem working right now?" by checking three things
and, when something is wrong, reporting it with a concrete suggested command.

The command **diagnoses and suggests only** — it never auto-runs a fix. Suggested
remediation commands are printed for the user (or the `doctor` skill) to run after
review.

## Scope

In scope (three checks):

1. **Build freshness** — is `dist/` rebuilt after the latest `src` change?
2. **Index integrity** — does the memory index pass `verifyMemoryIndex`?
3. **Data health** — does `getMemoryStats` show a usable, vectorized index?

Out of scope:

- Config / LLM provider validation (already covered by the `setup` skill).
- MCP connection and SessionStart hook checks.
- Auto-repair (chosen mode is diagnose + suggest).

## Checks

| # | Check | Source | `ok` | `warn` | `fail` | Suggestion |
|---|-------|--------|------|--------|--------|------------|
| 1 | Build freshness | `dist/cli-internal.mjs`, `dist/mcp-server.mjs` mtime vs newest `src/**/*.ts` mtime | dist newer than src | — | a dist artifact missing OR older than newest src | `bun run build` |
| 2 | Index integrity | `verifyMemoryIndex(db)` | no issues | only retryable extraction errors | missing archives / invalid provenance / missing vectors / orphan vectors | `memmem sync` (retryable) |
| 3 | Data health | `getMemoryStats(db)` | records > 0 and `missingVectors === 0` | 0 records, or `missingVectors > 0` | — | `memmem sync` |

Notes:

- `verify`'s `missingVectors` is treated as `fail` (broken vector join), while
  `stats`'s `missingVectors` warn condition overlaps; integrity check owns the
  hard failure, data health owns the soft "needs sync" signal. They can both
  fire — that is acceptable and informative.
- 0 records is `warn`, not `fail`: a fresh install that hasn't synced yet is not
  broken.

## Code Structure

- **`src/core/doctor.ts`**
  - `interface DiagnosticResult { name: string; status: 'ok' | 'warn' | 'fail'; detail: string; suggestion?: string }`
  - `runDiagnostics(db: Database, opts: { distDir: string; srcDir: string }): DiagnosticResult[]`
  - Build-freshness path resolution is injected via `opts` so tests can point at
    fixtures and avoid coupling to a real `dist/`.
  - Reuses `verifyMemoryIndex(db)` and `getMemoryStats(db)` — no duplicated SQL.
  - Helper `newestMtime(dir, ext)` walks `*.ts` under `srcDir`.

- **`src/cli/doctor.ts`**
  - `runDoctorCli(): void` — opens DB via `openDatabase()`, resolves `distDir`/`srcDir`
    relative to the package root, calls `runDiagnostics`, prints a compact report
    (`✓` ok / `⚠` warn / `✗` fail) with suggestions, sets `process.exitCode = 1`
    if any check is `fail`. Closes DB in `finally`.

- **`src/cli/main.ts`**
  - Add `doctor` to the command switch and to `getHelpText()`.

- **`src/core/doctor.test.ts`**
  - In-memory DB cases: clean index → all ok; seeded retryable extraction error
    → integrity warn; 0 records → data warn; missing-vector record → data warn /
    integrity fail.
  - mtime cases using a temp dir: dist missing → fail; src newer than dist →
    fail; dist newer → ok.

- **`skills/doctor/SKILL.md`**
  - Invoke `memmem doctor`, interpret the report, and run suggested commands only
    after user approval.

## Design Decisions

- **Build artifacts checked**: only `dist/cli-internal.mjs` and
  `dist/mcp-server.mjs` (the actual TS bundles produced by `scripts/build.mjs`).
  Copied wrapper files are not TS-derived and are skipped.
- **src mtime**: max mtime across all `src/**/*.ts`. If any tracked dist artifact
  is older than that max, the build is stale.
- **Missing DB**: `openDatabase()` creates an empty DB if absent; this surfaces
  naturally as a data-health `warn` (0 records). No special-casing needed.
- **No auto-run**: CLI prints suggestions only, matching the chosen
  diagnose + suggest mode.

## Verification

- `bun test src/core/doctor.test.ts` passes.
- `bun run typecheck` clean.
- `bun run build` then `bun run cli doctor` prints a report on the real
  environment.
