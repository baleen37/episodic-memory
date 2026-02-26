# IPC Socket Removal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use core:executing-plans to implement this plan task-by-task.

**Goal:** Replace IPC socket embedding architecture with direct in-process calls.

**Architecture:** Delete `embedding-worker.ts` (server) and rewrite `embeddings.ts` (client) to call `embeddings-model.ts` directly. Public API (`isEmbeddingsDisabled`, `initEmbeddings`, `generateEmbedding`) stays identical. Callers (`db.ts`, `search.ts`) need no changes.

**Tech Stack:** bun:test, @huggingface/transformers, sqlite-vec

---

### Task 1: Rewrite `embeddings.ts` and its tests

**Files:**
- Rewrite: `src/core/embeddings.ts`
- Rewrite: `src/core/embeddings.test.ts`

**Step 1: Write the new `embeddings.ts`**

Replace 151-line IPC client with direct calls:

```typescript
/**
 * In-process embedding generation via HuggingFace transformers.
 * Model is lazy-loaded on first use and stays in memory.
 */
import { initModel, generateEmbeddingFromModel } from './embeddings-model.js';
import { getEmbeddingRateLimiter } from './ratelimiter.js';

export function isEmbeddingsDisabled(): boolean {
  return process.env.MEMMEM_DISABLE_EMBEDDINGS === 'true';
}

export async function initEmbeddings(): Promise<void> {
  if (isEmbeddingsDisabled()) return;
  await initModel();
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (isEmbeddingsDisabled()) return null;
  try {
    await getEmbeddingRateLimiter().acquire();
    return await generateEmbeddingFromModel(text);
  } catch {
    return null;
  }
}
```

**Step 2: Write the new `embeddings.test.ts`**

Mock `embeddings-model.js` instead of IPC sockets. No more `__setWorkerConnectorForTests`, no mock socket helpers.

```typescript
import { describe, test, expect, beforeEach, afterEach, mock, afterAll } from 'bun:test';
import { EMBEDDING_DIM } from './constants.js';
import { resetRateLimiters, __setLoadConfigForTests } from './ratelimiter.js';

const mockEmbedding = Array.from({ length: EMBEDDING_DIM }, (_, i) => i * 0.001);
let shouldFail = false;

mock.module('./embeddings-model.js', () => ({
  initModel: mock(async () => {
    if (shouldFail) throw new Error('model load failed');
  }),
  generateEmbeddingFromModel: mock(async () => {
    if (shouldFail) throw new Error('generation failed');
    return mockEmbedding;
  }),
}));

describe('isEmbeddingsDisabled()', () => {
  afterEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
  });

  test('returns false by default', async () => {
    const { isEmbeddingsDisabled } = await import('./embeddings.js');
    expect(isEmbeddingsDisabled()).toBe(false);
  });

  test('returns true when MEMMEM_DISABLE_EMBEDDINGS=true', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    const { isEmbeddingsDisabled } = await import('./embeddings.js');
    expect(isEmbeddingsDisabled()).toBe(true);
  });
});

describe('generateEmbedding()', () => {
  beforeEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
    __setLoadConfigForTests(() => ({
      provider: 'gemini',
      apiKey: 'test',
      ratelimit: { embedding: { requestsPerSecond: 100, burstSize: 100 } },
    }) as any);
    resetRateLimiters();
  });

  afterEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
    __setLoadConfigForTests(null);
    resetRateLimiters();
  });

  test('returns null when disabled', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    const { generateEmbedding } = await import('./embeddings.js');
    expect(await generateEmbedding('test')).toBeNull();
  });

  test('returns embedding from model', async () => {
    const { generateEmbedding } = await import('./embeddings.js');
    const result = await generateEmbedding('hello world');
    expect(result).toEqual(mockEmbedding);
  });

  test('returns null on model error', async () => {
    shouldFail = true;
    const { generateEmbedding } = await import('./embeddings.js');
    const result = await generateEmbedding('hello');
    expect(result).toBeNull();
  });

  test('handles concurrent requests', async () => {
    const { generateEmbedding } = await import('./embeddings.js');
    const results = await Promise.all([
      generateEmbedding('text 1'),
      generateEmbedding('text 2'),
      generateEmbedding('text 3'),
    ]);
    expect(results).toHaveLength(3);
    results.forEach(r => expect(r).toHaveLength(EMBEDDING_DIM));
  });
});

describe('initEmbeddings()', () => {
  beforeEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
  });

  afterEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
  });

  test('no-ops when disabled', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    const { initEmbeddings } = await import('./embeddings.js');
    await expect(initEmbeddings()).resolves.toBeUndefined();
  });

  test('calls initModel when enabled', async () => {
    const { initEmbeddings } = await import('./embeddings.js');
    await expect(initEmbeddings()).resolves.toBeUndefined();
  });
});
```

**Step 3: Run tests**

Run: `bun test src/core/embeddings.test.ts`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add src/core/embeddings.ts src/core/embeddings.test.ts
git commit -m "refactor: replace IPC socket with in-process embedding"
```

---

### Task 2: Delete worker files

**Files:**
- Delete: `src/mcp/embedding-worker.ts`
- Delete: `src/mcp/embedding-worker.test.ts`

**Step 1: Delete files**

```bash
rm src/mcp/embedding-worker.ts src/mcp/embedding-worker.test.ts
```

**Step 2: Run tests to verify nothing depends on deleted files**

Run: `bun test`
Expected: All tests pass. No imports reference `embedding-worker`.

**Step 3: Commit**

```bash
git add -u
git commit -m "refactor: delete embedding worker (IPC server)"
```

---

### Task 3: Update `embeddings-model.ts` comment

**Files:**
- Modify: `src/core/embeddings-model.ts:1-4`

**Step 1: Remove worker-only restriction comment**

Change the file header from:
```typescript
/**
 * Direct in-process embedding model loading via HuggingFace transformers.
 * Used only by the embedding worker process. Do NOT import this from other modules.
 */
```
To:
```typescript
/**
 * In-process embedding model loading via HuggingFace transformers.
 * Lazy-loaded singleton: first call to initModel() loads the model.
 */
```

**Step 2: Commit**

```bash
git add src/core/embeddings-model.ts
git commit -m "docs: update embeddings-model comment for in-process usage"
```

---

### Task 4: Remove worker build entrypoint

**Files:**
- Modify: `scripts/build.mjs:52`

**Step 1: Remove embedding-worker build line**

Delete this line from `buildCli()`:
```javascript
    await buildEntry("src/mcp/embedding-worker.ts", "dist/embedding-worker.mjs");
```

**Step 2: Run build**

Run: `bun run build`
Expected: Builds successfully. `dist/embedding-worker.mjs` is NOT generated. Only `cli-internal.mjs` and `mcp-server.mjs`.

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: No errors.

**Step 4: Commit**

```bash
git add scripts/build.mjs
git commit -m "build: remove embedding-worker entrypoint"
```

---

### Task 5: Fix integration test (remove mock socket)

**Files:**
- Modify: `src/integration.test.ts`

**Step 1: Remove IPC mock socket infrastructure**

The integration test currently uses `__setWorkerConnectorForTests` and `createMockEmbeddingSocket`. Replace with `mock.module` for `embeddings-model.js`.

Remove these imports and helpers:
- `import { __setWorkerConnectorForTests } from './core/embeddings.js';`
- `import net from 'net';`
- `import EventEmitter from 'events';`
- `const MOCK_EMBEDDING = ...`
- `function createMockEmbeddingSocket() { ... }`

Remove from `beforeEach`:
- `__setWorkerConnectorForTests(() => Promise.resolve(createMockEmbeddingSocket()));`

Remove from `afterEach`:
- `__setWorkerConnectorForTests(null);`

Add at the top (after other imports):
```typescript
import { EMBEDDING_DIM } from './core/constants.js';
import { resetRateLimiters, __setLoadConfigForTests } from './core/ratelimiter.js';

const MOCK_EMBEDDING = Array.from({ length: EMBEDDING_DIM }, () => 0.1);

mock.module('./core/embeddings-model.js', () => ({
  initModel: mock(async () => undefined),
  generateEmbeddingFromModel: mock(async () => MOCK_EMBEDDING),
}));
```

Add to `beforeEach`:
```typescript
__setLoadConfigForTests(() => ({
  provider: 'gemini', apiKey: 'test',
  ratelimit: { embedding: { requestsPerSecond: 100, burstSize: 100 } },
}) as any);
resetRateLimiters();
```

Add to `afterEach`:
```typescript
__setLoadConfigForTests(null);
resetRateLimiters();
```

Note: The `runStop` helper uses a custom `createObservationFn` that bypasses `generateEmbedding` entirely (inserts `MOCK_EMBEDDING` directly). This still works — `MOCK_EMBEDDING` just changes from `Float32Array` to `number[]`, which `Buffer.from(new Float32Array(MOCK_EMBEDDING).buffer)` handles fine.

**Step 2: Run integration tests**

Run: `bun test src/integration.test.ts`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add src/integration.test.ts
git commit -m "test: remove IPC mock from integration tests"
```

---

### Task 6: Run full test suite and build verification

**Step 1: Run all tests**

Run: `bun test`
Expected: All tests pass, no regressions.

**Step 2: Run build**

Run: `bun run build`
Expected: Success, no `dist/embedding-worker.mjs`.

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: No errors.

**Step 4: Verify no stale references**

Run: `grep -r "embedding-worker" src/ scripts/ --include="*.ts" --include="*.mjs"`
Expected: No matches (only `dist/` or docs may have references).

Run: `grep -r "__setWorkerConnectorForTests" src/`
Expected: No matches.

Run: `grep -r "MEMMEM_WORKER_BINARY" src/`
Expected: No matches.
