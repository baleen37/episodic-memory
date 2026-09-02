# Unified Memory Search/Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose compact `search` and bounded multi-ID `read` retrieval for episodic-memory with a default limit of 10 and no public threshold/explain controls.

**Architecture:** Keep the existing SQLite/mem0 record model and strict multi-query search. Add a small reversible public-ID adapter at the MCP boundary, keep canonical UUIDs internal, and add direct record lookup for `read({ ids })`.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, SQLite-vec, Zod, MCP SDK, Bun tests.

**Spec:** `docs/superpowers/specs/2026-09-02-unified-memory-search-read-design.md`

## Global Constraints

- Default search limit is `10`; the existing maximum remains `50`.
- Search arrays remain strict AND queries with 2-5 strings.
- Public search input has `query` and optional `limit` only.
- Public retrieval tools are exactly `search` and `read` in this server.
- `read` accepts 1-10 IDs and returns `{ results, missing }` in request order.
- Canonical SQLite IDs remain internal; public IDs use reversible compact aliases.
- Existing unrelated `.verify/` changes must remain untouched.

### Task 1: Add compact public IDs and direct record lookup

**Files:**
- Create: `src/mcp/ids.ts`
- Create: `src/core/memory/read.ts`
- Test: `src/mcp/ids.test.ts`
- Test: `src/core/memory/read.test.ts`

**Interfaces:**
- `compactMemoryId(canonicalId: string): string`
- `expandMemoryId(publicId: string): string`
- `readMemories(db: Database, ids: string[]): { results: MemoryRecord[]; missing: string[] }`

- [ ] **Step 1: Write failing ID and read tests**

```ts
test('encodes UUIDs into a reversible 24-character public id', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const publicId = compactMemoryId(id);
  expect(publicId).toHaveLength(24);
  expect(expandMemoryId(publicId)).toBe(id);
});

test('reads requested memory records in requested order and reports missing ids', () => {
  const result = readMemories(db, ['m2', 'missing', 'm1']);
  expect(result.results.map((row) => row.id)).toEqual(['m2', 'm1']);
  expect(result.missing).toEqual(['missing']);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `bun test src/mcp/ids.test.ts src/core/memory/read.test.ts`

Expected: FAIL because the new ID and read modules do not exist.

- [ ] **Step 3: Implement the smallest reversible ID codec and SQLite lookup**

Use `e_` plus base64url UUID bytes for UUIDs, `e~` plus base64url UTF-8 for
legacy IDs, and keep non-public canonical IDs accepted by `expandMemoryId`.
`readMemories` must query only the requested IDs, parse metadata, preserve
request order, and put unresolved IDs in `missing`.

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `bun test src/mcp/ids.test.ts src/core/memory/read.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ids.ts src/mcp/ids.test.ts src/core/memory/read.ts src/core/memory/read.test.ts
git commit -m "feat: add compact episodic memory ids and reads"
```

### Task 2: Remove public search knobs and set the fixed default

**Files:**
- Modify: `src/core/memory/search.ts`
- Modify: `src/mcp/schemas.ts`
- Test: `src/core/memory/search.test.ts`
- Test: `src/mcp/schemas.test.ts`

**Interfaces:**
- `SearchArgs` and `MultiSearchArgs` no longer contain `threshold` or `explain`.
- `SearchInputSchema` parses `{ query, limit? }`, with `limit` defaulting to 10.

- [ ] **Step 1: Replace knob tests with fixed-policy tests**

```ts
test('uses a default search limit of 10', async () => {
  const { results } = await searchMemories({ db, query: 'memory', filters });
  expect(results).toHaveLength(10);
});

test('rejects removed threshold and explain inputs', () => {
  expect(SearchInputSchema.safeParse({ query: 'memory', threshold: 0.2 }).success).toBe(false);
  expect(SearchInputSchema.safeParse({ query: 'memory', explain: false }).success).toBe(false);
});
```

- [ ] **Step 2: Run focused tests and verify the new assertions fail**

Run: `bun test src/core/memory/search.test.ts src/mcp/schemas.test.ts`

Expected: FAIL because the old public fields and default limit still exist.

- [ ] **Step 3: Set the fixed internal threshold and remove public forwarding**

Set the core default limit to 10, use the existing 0.1 threshold internally,
always disable score explanations at the search boundary, remove the fields
from Zod and handler-facing types, and retain strict AND candidate behavior.

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `bun test src/core/memory/search.test.ts src/mcp/schemas.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/memory/search.ts src/core/memory/search.test.ts src/mcp/schemas.ts src/mcp/schemas.test.ts
git commit -m "refactor: fix episodic search controls"
```

### Task 3: Expose compact MCP search/read tools

**Files:**
- Modify: `src/mcp/handlers.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.ts`
- Test: `src/mcp/handlers.test.ts`
- Test: `src/mcp/server.handler.test.ts`
- Test: `src/mcp/server.test.ts`

**Interfaces:**
- `handleSearch(params, db): Promise<{ results: CompactSearchResult[] }>`
- `handleRead(params, db): Promise<{ results: ReadMemoryResult[]; missing: string[] }>`
- Tool list: `search`, `read`.

- [ ] **Step 1: Add failing handler and tool-surface tests**

```ts
test('returns compact public cards and hides canonical fields', async () => {
  const { results } = await handleSearch({ query: 'puppy' }, db);
  expect(results[0]).toEqual(expect.objectContaining({ id: expect.stringMatching(/^e/), text: expect.any(String) }));
  expect(results[0]).not.toHaveProperty('metadata');
  expect(results[0]).not.toHaveProperty('hash');
});

test('exposes search and read tools', () => {
  expect(TOOLS.map((tool) => tool.name)).toEqual(['search', 'read']);
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `bun test src/mcp/handlers.test.ts src/mcp/server.handler.test.ts src/mcp/server.test.ts`

Expected: FAIL because only the old full-record search tool exists.

- [ ] **Step 3: Implement adapters and the read dispatch**

Map internal results to `{ id, text, date, score }`, round score to three
decimals, and omit query/options metadata. Register `read` with strict
`{ ids: string[1..10] }` validation. Decode public IDs before SQLite lookup and
return detail records with `{ id, text, metadata, created_at, updated_at }`.

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `bun test src/mcp/handlers.test.ts src/mcp/server.handler.test.ts src/mcp/server.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/handlers.ts src/mcp/tools.ts src/mcp/server.ts src/mcp/handlers.test.ts src/mcp/server.handler.test.ts src/mcp/server.test.ts
git commit -m "feat: expose compact episodic search and read tools"
```

### Task 4: Update user-facing documentation and verify the runtime

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Test: `src/e2e/runtime-compat.e2e.test.ts`

- [ ] **Step 1: Write the failing runtime/documentation assertions**

```ts
test('real MCP tools/list exposes search and read', async () => {
  const tools = await listToolsFromFreshServer();
  expect(tools.map((tool) => tool.name)).toEqual(['search', 'read']);
});
```

- [ ] **Step 2: Run the focused runtime test and verify it fails**

Run: `bun test src/e2e/runtime-compat.e2e.test.ts`

Expected: FAIL because the runtime still exposes only `search`.

- [ ] **Step 3: Update examples and runtime assertions**

Document `search({ query, limit? })`, strict array queries, and
`read({ ids })`. Remove examples containing `threshold` or `explain`.

- [ ] **Step 4: Run the focused test, build, and diff checks**

Run: `bun test src/e2e/runtime-compat.e2e.test.ts && npm run build && git diff --check`

Expected: PASS with the real stdio server listing `search` and `read`.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md src/e2e/runtime-compat.e2e.test.ts
git commit -m "docs: document compact episodic retrieval"
```
