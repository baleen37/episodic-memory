# Bun Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate memmem from Node.js/npm/vitest/esbuild to Bun across all layers.

**Architecture:** Three staged phases — (1) replace `better-sqlite3` with `bun:sqlite`, (2) replace `vitest` with `bun test`, (3) replace `esbuild` with `bun build`. Each phase ends with all tests passing before proceeding.

**Tech Stack:** Bun 1.x, `bun:sqlite` (built-in), `sqlite-vec` npm package, `bun test` (built-in), `Bun.build()` API

---

## Phase 1: `better-sqlite3` → `bun:sqlite`

### Key API differences

| better-sqlite3 | bun:sqlite |
|---|---|
| `import Database from 'better-sqlite3'` | `import { Database } from 'bun:sqlite'` |
| `db.prepare(sql).all(...params)` | `db.query(sql).all(...params)` |
| `db.prepare(sql).get(...params)` | `db.query(sql).get(...params)` |
| `db.prepare(sql).run(...params)` | `db.query(sql).run(...params)` |
| `db.exec(sql)` | `db.exec(sql)` (same) |
| `db.pragma('...')` | `db.exec('PRAGMA ...')` |
| `result.lastInsertRowid` | `result.lastInsertRowid` (same) |
| `db.loadExtension(path)` | `db.loadExtension(path)` |
| `Database.Database` type | `Database` type (no namespace) |

**macOS sqlite-vec issue:** Apple's default SQLite disables extension loading. Must call `Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib")` before any `new Database()`. Only needed on macOS.

### Task 1: Install bun and verify environment

**Files:** none

**Step 1: Check bun is installed**

```bash
bun --version
```
Expected: `1.x.x`

If not installed: `curl -fsSL https://bun.sh/install | bash`

**Step 2: Verify sqlite-vec bun compatibility**

```bash
bun -e "import { Database } from 'bun:sqlite'; console.log('ok')"
```
Expected: `ok`

**Step 3: Check Homebrew sqlite path (macOS only)**

```bash
ls /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib
```
Expected: file exists

---

### Task 2: Replace `better-sqlite3` with `bun:sqlite` in `src/core/db.ts`

**Files:**
- Modify: `src/core/db.ts`

**Step 1: Read current db.ts**

Read the full file before editing.

**Step 2: Replace import and type references**

Change:
```typescript
import Database from 'better-sqlite3';
```
To:
```typescript
import { Database } from 'bun:sqlite';

// macOS: Apple's default SQLite disables extensions; use Homebrew SQLite
if (process.platform === 'darwin') {
  Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
}
```

**Step 3: Update `db.pragma` call**

Change:
```typescript
db.pragma('journal_mode = WAL');
```
To:
```typescript
db.exec('PRAGMA journal_mode = WAL');
```

**Step 4: Update all `db.prepare(sql).all(...)` → `db.query(sql).all(...)`**

In `createDatabase()`:
```typescript
// Change:
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
// To:
const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];

// Change:
const observationColumns = db.prepare(`SELECT name FROM pragma_table_info('observations')`).all() as Array<{ name: string }>;
// To:
const observationColumns = db.query(`SELECT name FROM pragma_table_info('observations')`).all() as Array<{ name: string }>;

// Change:
const schemaResult = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_observations'").get() as { sql: string } | undefined;
// To:
const schemaResult = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_observations'").get() as { sql: string } | undefined;
```

**Step 5: Update `insertPendingEvent` function**

Change:
```typescript
const stmt = db.prepare(`INSERT INTO pending_events ...`);
const result = stmt.run(...);
return result.lastInsertRowid as number;
```
To:
```typescript
const result = db.query(`INSERT INTO pending_events (session_id, project, tool_name, compressed, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
  event.sessionId, event.project, event.toolName, event.compressed, event.timestamp, event.createdAt
);
return result.lastInsertRowid as number;
```

**Step 6: Update `insertObservation` function**

Change both `db.prepare(...).run(...)` calls to `db.query(...).run(...)`.

**Step 7: Update `getAllPendingEvents` function**

Change:
```typescript
const stmt = db.prepare(`SELECT ...`);
return stmt.all(sessionId) as Array<...>;
```
To:
```typescript
return db.query(`SELECT ...`).all(sessionId) as Array<...>;
```

**Step 8: Update `searchObservations` function**

Change:
```typescript
const stmt = db.prepare(sql);
return stmt.all(...params) as ObservationResult[];
```
To:
```typescript
return db.query(sql).all(...params) as ObservationResult[];
```

**Step 9: Update `getObservation` function**

Change:
```typescript
const stmt = db.prepare(`SELECT ...`);
const result = stmt.get(id) as ObservationResult | undefined;
```
To:
```typescript
const result = db.query(`SELECT ...`).get(id) as ObservationResult | undefined;
```

**Step 10: Update return type annotations**

Change all `Database.Database` type references to `Database`:
```typescript
// Change:
export function initDatabase(): Database.Database {
export function openDatabase(): Database.Database {
function createDatabase(wipe: boolean): Database.Database {
export function insertPendingEvent(db: Database.Database, ...
// etc.

// To:
export function initDatabase(): Database {
export function openDatabase(): Database {
function createDatabase(wipe: boolean): Database {
export function insertPendingEvent(db: Database, ...
// etc.
```

---

### Task 3: Update `src/core/observations.ts` and `src/core/search.ts`

**Files:**
- Modify: `src/core/observations.ts`
- Modify: `src/core/search.ts`

**Step 1: Read both files**

**Step 2: Update `observations.ts`**

Change:
```typescript
import Database from 'better-sqlite3';
```
To:
```typescript
import { Database } from 'bun:sqlite';
```

Change all `Database.Database` type refs to `Database`.
Change all `db.prepare(sql).all(params)` → `db.query(sql).all(params)`.
Change all `db.prepare(sql).get(params)` → `db.query(sql).get(params)`.
Change all `db.prepare(sql).run(params)` → `db.query(sql).run(params)`.

**Step 3: Update `search.ts`**

Same as above.

---

### Task 4: Update all other files using `better-sqlite3`

**Files:**
- Modify: `src/hooks/post-tool-use.ts`
- Modify: `src/hooks/stop.ts`
- Modify: `src/hooks/session-start.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/cli/observe-cli.ts`
- Modify: `src/cli/inject-cli.ts`

**Step 1: Find all remaining `better-sqlite3` imports**

```bash
grep -rn "better-sqlite3\|Database\.Database" src/ --include="*.ts" | grep -v ".test.ts"
```

**Step 2: For each file found:**
- Change `import Database from 'better-sqlite3'` → `import { Database } from 'bun:sqlite'`
- Change `Database.Database` → `Database`
- Change `db.prepare(sql).all(...)` → `db.query(sql).all(...)`
- Change `db.prepare(sql).get(...)` → `db.query(sql).get(...)`
- Change `db.prepare(sql).run(...)` → `db.query(sql).run(...)`

---

### Task 5: Update test files (Phase 1 - db type changes only)

**Files:**
- Modify: `src/core/db.test.ts`
- Modify: all other `*.test.ts` files that import `better-sqlite3`

**Step 1: Find test files with `better-sqlite3`**

```bash
grep -rn "better-sqlite3\|Database\.Database" src/ --include="*.test.ts"
```

**Step 2: Apply same import/type changes to each test file**

Only change imports and type annotations — do NOT change vitest APIs yet (that's Phase 2).

---

### Task 6: Update `package.json` and install with bun

**Files:**
- Modify: `package.json`

**Step 1: Remove `better-sqlite3` and its types from package.json**

Remove from `dependencies`:
```json
"better-sqlite3": "^9.6.0"
```

Remove from `devDependencies`:
```json
"@types/better-sqlite3": "^7.6.11"
```

**Step 2: Install with bun**

```bash
bun install
```

Expected: `bun.lockb` created, `node_modules` updated.

**Step 3: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors. Fix any type errors before proceeding.

**Step 4: Run tests (still using vitest for now)**

```bash
bun run test
```
Expected: All 576 tests pass.

**Step 5: Commit**

```bash
git add src/ package.json bun.lockb
git status  # verify no unexpected files
git commit -m "feat: replace better-sqlite3 with bun:sqlite"
```

---

## Phase 2: `vitest` → `bun test`

### Key API differences

| vitest | bun:test |
|---|---|
| `import { describe, it, expect, vi } from 'vitest'` | globals auto-injected (no import needed); `import { mock, spyOn } from 'bun:test'` for mocking |
| `vi.fn()` | `mock(() => {})` from `bun:test` |
| `vi.fn().mockReturnValue(x)` | `mock(() => x)` |
| `vi.fn().mockResolvedValue(x)` | `mock(async () => x)` |
| `vi.fn().mockRejectedValue(e)` | `mock(async () => { throw e })` |
| `vi.mock('module', factory)` | `mock.module('module', factory)` — must be at top level, NOT inside describe/it |
| `vi.hoisted(() => value)` | not needed — just declare the variable at top-level outside `mock.module()` |
| `vi.spyOn(obj, method)` | `spyOn(obj, method)` from `bun:test` |
| `vi.clearAllMocks()` | `jest.clearAllMocks()` — bun:test is jest-compatible; or call `.mockClear()` on each mock |
| `vi.resetModules()` | not needed for most cases with bun:test |
| `vi.useFakeTimers()` | `setSystemTime(new Date())` from `bun:test` |
| `vi.advanceTimersByTime(ms)` | advance real time isn't possible; use `setSystemTime()` to move clock |
| `vi.runAllTimersAsync()` | not available — restructure tests to not need this |
| `mockFn.mock.calls` | `mockFn.mock.calls` (same) |
| `vitest.config.ts` | `bunfig.toml` or CLI flags |

### Important: `vi.hoisted()` pattern

vitest's `vi.hoisted()` is used when you need a variable in `vi.mock()` factory that's defined after the mock. In bun:test, `mock.module()` is NOT hoisted — it runs in place. So you can simply declare variables at the top of the file:

```typescript
// vitest pattern:
const { mockFn } = vi.hoisted(() => ({ mockFn: vi.fn() }));
vi.mock('./module.js', () => ({ fn: mockFn }));

// bun:test pattern:
const mockFn = mock(() => {});
mock.module('./module.js', () => ({ fn: mockFn }));
```

### Important: fake timers in bun:test

`bun:test` uses `setSystemTime()` to control `Date.now()` and `new Date()`. For `setTimeout`/`setInterval` advancement, bun:test does NOT support arbitrary timer advancement. Tests using `vi.advanceTimersByTime()` must be restructured.

For `ratelimiter.test.ts` specifically — the rate limiter uses real `setTimeout`. Restructure by using `setSystemTime()` to mock the clock reading in the rate limiter, or make the rate limiter injectable with a clock function.

### Task 7: Migrate simple test files (no mocks, no fake timers)

These files only use `describe`, `it`/`test`, `expect`, `beforeEach`, `afterEach` — trivial migration.

**Files:**
- `src/core/read.test.ts`
- `src/core/archive.test.ts`
- `src/core/paths.test.ts`
- `src/core/db.test.ts`
- `src/core/llm/types.test.ts`
- `src/core/llm/index.test.ts`
- `src/core/llm/gemini-provider.test.ts`

**Step 1: For each file, remove vitest import**

Change:
```typescript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
```
To: _(delete the line entirely — bun:test injects globals)_

For files that import `vi`:
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
```
To:
```typescript
import { mock, spyOn } from 'bun:test';
```
(only if the file uses mocking — otherwise delete entirely)

**Step 2: Run bun test on each file to verify**

```bash
bun test src/core/read.test.ts
bun test src/core/archive.test.ts
# etc.
```
Expected: all pass.

---

### Task 8: Migrate mock-heavy test files

**Files:**
- `src/core/observations.test.ts`
- `src/core/search.test.ts`
- `src/core/embeddings.test.ts`
- `src/core/logger.test.ts`
- `src/core/llm/config.test.ts`
- `src/core/llm/batch-extract-prompt.test.ts`
- `src/core/llm/zai-provider.test.ts`
- `src/mcp/embedding-worker.test.ts`
- `src/mcp/server.handler.test.ts`
- `src/hooks/stop.test.ts`
- `src/hooks/session-start.test.ts`
- `src/hooks/post-tool-use.test.ts`
- `src/cli/observe-cli.test.ts`
- `src/cli/inject-cli.test.ts`
- `src/cli/index-cli.test.ts`
- `src/integration.test.ts`

**Step 1: Read each file carefully before editing**

**Step 2: For each file, apply these transformations:**

a) Remove vitest import, add bun:test mock imports:
```typescript
// Remove:
import { describe, it, expect, beforeEach, vi } from 'vitest';
// Add (only what's needed):
import { mock, spyOn } from 'bun:test';
```

b) Replace `vi.hoisted()` pattern:
```typescript
// Remove vi.hoisted wrapper, keep the value declaration:
// Before:
const { mockFn } = vi.hoisted(() => ({ mockFn: vi.fn() }));
// After:
const mockFn = mock(() => {});
```

c) Replace `vi.mock()` with `mock.module()`:
```typescript
// Before:
vi.mock('./embeddings.js', () => ({ generateEmbedding: mockGenerateEmbedding }));
// After:
mock.module('./embeddings.js', () => ({ generateEmbedding: mockGenerateEmbedding }));
```

d) Replace `vi.fn()` with `mock()`:
```typescript
// Before:
const mockFn = vi.fn();
const mockFn = vi.fn().mockReturnValue(42);
const mockFn = vi.fn().mockResolvedValue(result);
const mockFn = vi.fn().mockRejectedValue(new Error('oops'));
// After:
const mockFn = mock(() => {});
const mockFn = mock(() => 42);
const mockFn = mock(async () => result);
const mockFn = mock(async () => { throw new Error('oops') });
```

e) Replace `vi.spyOn()` with `spyOn()`:
```typescript
// Before:
const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
// After:
const spy = spyOn(console, 'log').mockImplementation(() => {});
```

f) Replace `vi.clearAllMocks()` with manual reset or per-mock `.mockClear()`:
```typescript
// Before:
vi.clearAllMocks();
// After:
mockFn.mockClear(); // or mockFn.mockReset()
// (call for each mock in the test)
```

**Step 3: Run each file's tests after migration**

```bash
bun test src/core/observations.test.ts
# etc.
```
Fix any failures before moving on.

---

### Task 9: Migrate `ratelimiter.test.ts` (fake timers)

This file uses `vi.useFakeTimers()`, `vi.advanceTimersByTime()`, `vi.runAllTimersAsync()` extensively.

**Files:**
- Modify: `src/core/ratelimiter.test.ts`

**Step 1: Read `src/core/ratelimiter.ts` to understand how time is used**

The rate limiter uses `Date.now()` and `setTimeout`. In bun:test, `setSystemTime()` controls `Date.now()` but does NOT advance `setTimeout` callbacks.

**Step 2: Use `setSystemTime` for Date.now() mocking**

```typescript
import { mock, setSystemTime } from 'bun:test';

beforeEach(() => {
  setSystemTime(0); // start at epoch 0
});

afterEach(() => {
  setSystemTime(); // restore real time
});
```

**Step 3: For tests that advance time and await timers**

Replace:
```typescript
vi.advanceTimersByTime(500);
await vi.runAllTimersAsync();
```
With: advance `setSystemTime` and use `await Bun.sleep(0)` to yield to the event loop:
```typescript
setSystemTime(500);
await Bun.sleep(0); // yield to event loop
```

**Step 4: Run the tests**

```bash
bun test src/core/ratelimiter.test.ts
```
Expected: all pass. If `setTimeout`-based tests fail, they may need restructuring — flag for jito.

---

### Task 10: Update `vitest.config.ts` → `bunfig.toml` and package.json scripts

**Files:**
- Delete: `vitest.config.ts`
- Create: `bunfig.toml`
- Modify: `package.json`

**Step 1: Create `bunfig.toml`**

```toml
[test]
timeout = 15000
```

**Step 2: Update `package.json` scripts**

Change:
```json
"test": "vitest run",
"test:watch": "vitest",
```
To:
```json
"test": "bun test",
"test:watch": "bun test --watch",
```

**Step 3: Remove vitest from devDependencies**

Remove:
```json
"vitest": "^3.0.0",
"@vitest/coverage-v8": "^3.0.0"
```

**Step 4: Run full test suite**

```bash
bun test
```
Expected: all tests pass.

**Step 5: Delete `vitest.config.ts`**

```bash
rm vitest.config.ts
```

**Step 6: Commit**

```bash
git add -p  # stage changes carefully
git commit -m "feat: replace vitest with bun test"
```

---

## Phase 3: `esbuild` → `bun build`

### Key API differences

| esbuild | bun build |
|---|---|
| `build({ entryPoints, outfile, platform, format, bundle, external })` | `Bun.build({ entrypoints, outfile, target, external })` |
| `platform: 'node', format: 'esm'` | `target: 'bun'` or `'node'` |
| `banner: { js: '#!/usr/bin/env node' }` | not supported in `Bun.build()` — append manually |
| `copyFile()` | same (Node.js fs API works in Bun) |

### Task 11: Rewrite `scripts/build.mjs` using `Bun.build()`

**Files:**
- Modify: `scripts/build.mjs`

**Step 1: Read current `scripts/build.mjs`**

**Step 2: Rewrite using `Bun.build()`**

```javascript
#!/usr/bin/env bun
import { mkdir, copyFile, appendFile, readFile, writeFile } from "fs/promises";
import { join } from "path";

const external = [
  "@huggingface/transformers",
  "bun:sqlite",
  "sharp",
  "onnxruntime-node",
  "sqlite-vec",
];

async function buildEntry(entrypoint, outfile) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outfile,
    target: "node",
    external,
    minify: false,
    sourcemap: "none",
  });

  if (!result.success) {
    console.error(`Build failed for ${entrypoint}:`, result.logs);
    process.exit(1);
  }

  // Prepend shebang (bun build doesn't support banner option)
  const content = await readFile(outfile, "utf8");
  await writeFile(outfile, "#!/usr/bin/env node\n" + content);
}

async function buildAll() {
  await mkdir("dist", { recursive: true });

  await buildEntry("src/cli/index-cli.ts", "dist/cli-internal.mjs");
  console.log("✓ Built dist/cli-internal.mjs");

  await copyFile(join("src", "cli-graceful.mjs"), join("dist", "cli.mjs"));
  console.log("✓ Copied dist/cli.mjs (graceful wrapper)");

  await buildEntry("src/mcp/server.ts", "dist/mcp-server.mjs");
  console.log("✓ Built dist/mcp-server.mjs");

  await buildEntry("src/mcp/embedding-worker.ts", "dist/embedding-worker.mjs");
  console.log("✓ Built dist/embedding-worker.mjs");

  await mkdir("dist/lib", { recursive: true });
  await copyFile(join("scripts", "mcp-server-wrapper.mjs"), join("dist", "mcp-wrapper.mjs"));
  console.log("✓ Copied dist/mcp-wrapper.mjs");

  await copyFile(join("scripts", "lib", "check-dependencies.mjs"), join("dist", "lib", "check-dependencies.mjs"));
  console.log("✓ Copied dist/lib/check-dependencies.mjs");

  console.log("\n✅ Build complete!");
}

buildAll();
```

**Step 3: Update `package.json` build script**

Change:
```json
"build": "node scripts/build.mjs"
```
To:
```json
"build": "bun scripts/build.mjs"
```

**Step 4: Update `scripts/conditional-build.sh`**

Change:
```bash
npm run build
```
To:
```bash
bun run build
```
(two occurrences)

**Step 5: Remove esbuild from devDependencies**

```json
// Remove:
"esbuild": "^0.25.0"
```

**Step 6: Run the build**

```bash
bun run build
```
Expected: all artifacts in `dist/` built successfully.

**Step 7: Smoke test the CLI**

```bash
node dist/cli.mjs --help
```
Expected: help output displayed.

**Step 8: Commit**

```bash
git add scripts/build.mjs scripts/conditional-build.sh package.json bun.lockb
git commit -m "feat: replace esbuild with bun build"
```

---

## Final cleanup

### Task 12: Update `package.json` engines and `CLAUDE.md`

**Files:**
- Modify: `package.json`
- Modify: `CLAUDE.md`

**Step 1: Update `package.json` engines**

Change:
```json
"engines": {
  "node": ">=18.0.0"
}
```
To:
```json
"engines": {
  "bun": ">=1.0.0"
}
```

**Step 2: Update `package.json` scripts for typecheck and cli**

Change:
```json
"typecheck": "tsc --noEmit",
"cli": "node dist/cli.mjs"
```
To:
```json
"typecheck": "tsc --noEmit",
"cli": "bun dist/cli.mjs"
```

**Step 3: Update `CLAUDE.md`**

Find the line:
```
**CRITICAL**: Always use `npm`, never `bun` — `better-sqlite3` requires Node.js native bindings.
```
Replace with:
```
**CRITICAL**: Always use `bun` — this project uses `bun:sqlite` (built-in) and `bun test`.
```

Also update the Commands section:
```bash
bun test                        # Run all tests
bun test path/to/file.test.ts   # Run single test file
bun test --watch                # Watch mode
bun run build                   # Bundle with bun build (scripts/build.mjs)
bun run typecheck               # tsc --noEmit
```

**Step 4: Delete `package-lock.json` if it exists**

```bash
ls package-lock.json && rm package-lock.json || true
```

**Step 5: Final full test run**

```bash
bun test
```
Expected: all tests pass.

**Step 6: Final build**

```bash
bun run build
```
Expected: success.

**Step 7: Commit**

```bash
git add package.json CLAUDE.md
git commit -m "chore: update engines and docs for bun migration"
```
