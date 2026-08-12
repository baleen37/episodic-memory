# Embedding Throughput and Failure Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop silently discarding extracted facts on embedding failure, and remove ~96.8 min/day of artificial rate-limiter waiting from the embedding path.

**Architecture:** Four surgical changes inside existing files. `embeddings.ts` gains an `EmbeddingError` that it throws instead of returning `null`, letting `sync.ts`'s existing retry guard catch embedding failures. The per-second rate limiter is replaced by a concurrency semaphore (rps is the wrong instrument for an in-process CPU model). `add.ts` embeds a whole batch in one model call. `EXTRACTION_BUDGET_PER_SYNC` is re-derived now that embedding is no longer a bottleneck. No new processes, no new subsystems.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun:sqlite`), `@huggingface/transformers` 4.2.0 (ONNX), `Xenova/multilingual-e5-small` (384-dim, `dtype: 'fp16'`).

**Spec:** `docs/superpowers/specs/2026-08-11-embedding-throughput-design.md`

## Global Constraints

- **Always use `bun`**, never `node` or `npm`. This project uses `bun:sqlite` and `bun test`.
- **Never call `initDatabase()`** in production code — it wipes the database. In tests, set `TEST_DB_PATH=':memory:'` before any DB work.
- Embedding dimension is **384** (`EMBEDDING_DIM` in `src/core/constants.ts`). Never hardcode the number in new code; import the constant.
- Model is `Xenova/multilingual-e5-small` with `dtype: 'fp16'`. Prefixes are `'passage: '` and `'query: '`; truncation is `MAX_CONTENT_CHARS = 8000` per text.
- `MEMMEM_DISABLE_EMBEDDINGS === 'true'` must keep returning `null` (not throw). Verified: only tests set it, but the disabled path is public behavior with existing tests.
- Storage language is English; do not touch prompts or extraction text.
- After modifying TypeScript, rebuild with `bun run build`.
- Match existing file style. Do not reformat or "improve" adjacent code.

## Measured Baseline (do not re-derive; verify against these)

| Quantity | Measured |
| --- | --- |
| Inference, per text | 12.6 ms |
| Model load, warm | 488 ms (median 493 ms over 43 loads; total 125 s/day) |
| `add.ts` path, 10 facts | **18.0 s** |
| Pure compute, same 10 facts | 0.126 s |
| Batch of 10 vs 10 sequential model calls | **65 ms vs 395 ms** |
| Rate-limiter waste (2905 facts/day @ 0.5 rps) | ~5810 s ≈ **96.8 min/day** |
| Silent embedding failures | **115/day** |
| Sync backlog trend | 1892 → 7214 in one day; budget exhausted 31x |

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/core/embeddings.ts` | Public embedding API; disabled-check, concurrency gating, error policy | Modify: add `EmbeddingError`, throw on failure, add `embedPassageBatch`, swap rate limiter for semaphore |
| `src/core/embeddings-model.ts` | Model load + inference | Modify: add `generateEmbeddingsFromModel(kind, texts[])` |
| `src/core/semaphore.ts` | Bound concurrent async work. Pure, no I/O | **Create** |
| `src/core/llm/config.ts` | Config file shape + loading | Modify: add `embedding.maxConcurrency` |
| `src/core/memory/add.ts` | Ingestion pipeline | Modify: line 50 → batch call; drop now-dead null check |
| `src/core/memory/search.ts` | Hybrid search | Modify: catch `EmbeddingError` → empty results + warn |
| `src/cli/sync.ts` | Sync CLI | Modify: `EXTRACTION_BUDGET_PER_SYNC` 20 → 60 + comment |

`semaphore.ts` is a separate file because it is pure logic with no dependency on embeddings, which makes it unit-testable without loading a 235 MB model.

---

### Task 1: Concurrency semaphore

A standalone primitive that bounds how many async operations run at once. Nothing else in this task depends on embeddings, so it can be tested in milliseconds.

**Files:**
- Create: `src/core/semaphore.ts`
- Test: `src/core/semaphore.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export class Semaphore { constructor(maxConcurrent: number); acquire(): Promise<void>; release(): void; }`
  - `export function withSemaphore<T>(sem: Semaphore, fn: () => Promise<T>): Promise<T>`

- [ ] **Step 1: Write the failing test**

Create `src/core/semaphore.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { Semaphore, withSemaphore } from './semaphore.js';

describe('Semaphore', () => {
  test('never exceeds maxConcurrent', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;

    const task = () => withSemaphore(sem, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
      return true;
    });

    await Promise.all(Array.from({ length: 10 }, task));
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  test('releases the slot when the callback throws', async () => {
    const sem = new Semaphore(1);
    await expect(withSemaphore(sem, async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');

    // If the slot leaked, this would hang forever rather than resolve.
    const result = await withSemaphore(sem, async () => 'ok');
    expect(result).toBe('ok');
  });

  test('runs everything when maxConcurrent exceeds the work count', async () => {
    const sem = new Semaphore(8);
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, i) => withSemaphore(sem, async () => i)),
    );
    expect(results).toEqual([0, 1, 2]);
  });

  test('treats a non-positive limit as 1', async () => {
    const sem = new Semaphore(0);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 4 }, () => withSemaphore(sem, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    })));
    expect(peak).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/core/semaphore.test.ts`
Expected: FAIL — cannot resolve module `./semaphore.js`

- [ ] **Step 3: Write the implementation**

Create `src/core/semaphore.ts`:

```typescript
/**
 * Bounds how many async operations run concurrently.
 *
 * Used for in-process embedding: the work is CPU-bound and cheap per call
 * (~12.6ms), so a requests-per-second limit only adds latency. What actually
 * needs bounding is simultaneous inference across callers (several MCP servers
 * can embed at once, and ONNX runtime is itself multi-threaded per call).
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.available = Math.max(1, Math.floor(maxConcurrent));
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }
}

/** Runs `fn` holding one slot, releasing it even if `fn` throws. */
export async function withSemaphore<T>(sem: Semaphore, fn: () => Promise<T>): Promise<T> {
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/core/semaphore.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/semaphore.ts src/core/semaphore.test.ts
git commit -m "feat(core): add concurrency semaphore"
```

---

### Task 2: Config key for embedding concurrency

Adds `embedding.maxConcurrency` to the config shape so the cap is tunable, defaulting to 4.

**Files:**
- Modify: `src/core/llm/config.ts` (the `LLMConfig` interface and its doc comment)
- Test: `src/core/llm/config.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1
- Produces:
  - `export interface EmbeddingConfig { maxConcurrency?: number }`
  - `LLMConfig` gains an optional `embedding?: EmbeddingConfig` field
  - `export const DEFAULT_EMBEDDING_MAX_CONCURRENCY = 4`

- [ ] **Step 1: Write the failing test**

Append to `src/core/llm/config.test.ts`. Note this file uses `it`, not `test` — match it. It already imports `__setConfigFileDepsForTests` (line 11) and uses it for mocking (line 26):

```typescript
describe('embedding config', () => {
  afterEach(() => {
    __setConfigFileDepsForTests(null);
  });

  it('reads embedding.maxConcurrency from the config file', () => {
    __setConfigFileDepsForTests({
      existsSync: () => true,
      readFileSync: (() => JSON.stringify({
        provider: 'gemini',
        apiKey: 'k',
        embedding: { maxConcurrency: 7 },
      })) as never,
    });
    expect(loadConfig()?.embedding?.maxConcurrency).toBe(7);
  });

  it('leaves embedding undefined when the config omits it', () => {
    __setConfigFileDepsForTests({
      existsSync: () => true,
      readFileSync: (() => JSON.stringify({ provider: 'gemini', apiKey: 'k' })) as never,
    });
    expect(loadConfig()?.embedding).toBeUndefined();
  });

  it('DEFAULT_EMBEDDING_MAX_CONCURRENCY is 4', () => {
    expect(DEFAULT_EMBEDDING_MAX_CONCURRENCY).toBe(4);
  });
});
```

Add `DEFAULT_EMBEDDING_MAX_CONCURRENCY` to the existing import from `./config.js` at the top of that test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/core/llm/config.test.ts`
Expected: FAIL — `DEFAULT_EMBEDDING_MAX_CONCURRENCY` is not exported

- [ ] **Step 3: Write the implementation**

In `src/core/llm/config.ts`, after the `RateLimitsConfig` interface, add:

```typescript
/** Default number of embedding calls allowed to run at once. */
export const DEFAULT_EMBEDDING_MAX_CONCURRENCY = 4;

/**
 * Embedding configuration.
 *
 * The embedding model runs in-process on CPU, so throughput is bounded by
 * concurrency rather than by a request rate.
 */
export interface EmbeddingConfig {
  /** Maximum embedding calls allowed to run at once (default 4) */
  maxConcurrency?: number;
}
```

Add the field to `LLMConfig`, immediately after `ratelimit`:

```typescript
  /** Optional embedding configuration */
  embedding?: EmbeddingConfig;
```

Extend the module's `@example` JSON doc comment at the top of the file to include the new key alongside `ratelimit`:

```
 *   "embedding": { "maxConcurrency": 4 },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/core/llm/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/llm/config.ts src/core/llm/config.test.ts
git commit -m "feat(config): add embedding.maxConcurrency"
```

---

### Task 3: Batch inference in the model layer

Adds a batch entry point that runs one forward pass for N texts. Measured 65 ms for 10 texts versus 395 ms for 10 separate calls.

**Files:**
- Modify: `src/core/embeddings-model.ts`
- Test: `src/core/embeddings-model.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing from Tasks 1–2
- Produces:
  - `export async function generateEmbeddingsFromModel(kind: 'passage' | 'query', texts: string[]): Promise<number[][]>`

Verified against `@huggingface/transformers` 4.2.0: `_call(texts: string | string[], ...)` (`types/pipelines.d.ts:629`). Calling it with 3 texts returns a tensor with `dims === [3, 384]` and `data.length === 1152` — contiguous 384-float rows in input order.

- [ ] **Step 1: Write the failing test**

Create `src/core/embeddings-model.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { sliceBatchOutput } from './embeddings-model.js';
import { EMBEDDING_DIM } from './constants.js';

describe('sliceBatchOutput', () => {
  test('splits a flat tensor into one vector per input', () => {
    const rows = 3;
    const data = new Float32Array(rows * EMBEDDING_DIM);
    for (let i = 0; i < data.length; i++) data[i] = i;

    const result = sliceBatchOutput(data, rows);

    expect(result).toHaveLength(rows);
    expect(result[0]).toHaveLength(EMBEDDING_DIM);
    expect(result[0][0]).toBe(0);
    expect(result[1][0]).toBe(EMBEDDING_DIM);
    expect(result[2][EMBEDDING_DIM - 1]).toBe(rows * EMBEDDING_DIM - 1);
  });

  test('throws when the tensor length is not a multiple of the row count', () => {
    const data = new Float32Array(EMBEDDING_DIM + 5);
    expect(() => sliceBatchOutput(data, 2)).toThrow(/expected 2/);
  });

  test('returns an empty array for zero rows', () => {
    expect(sliceBatchOutput(new Float32Array(0), 0)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/core/embeddings-model.test.ts`
Expected: FAIL — `sliceBatchOutput` is not exported

- [ ] **Step 3: Write the implementation**

In `src/core/embeddings-model.ts`, add the exported helper and the batch function. Place `sliceBatchOutput` above `generateEmbeddingFromModel`:

```typescript
/**
 * Splits a batched feature-extraction tensor into one vector per input.
 *
 * transformers.js returns `dims = [rows, EMBEDDING_DIM]` with contiguous rows
 * in input order, so the flat buffer slices evenly.
 */
export function sliceBatchOutput(data: ArrayLike<number>, rows: number): number[][] {
  if (rows === 0) return [];
  const expected = rows * EMBEDDING_DIM;
  if (data.length !== expected) {
    throw new Error(
      `batch embedding size mismatch: expected ${expected} floats for ${rows} texts, got ${data.length}`,
    );
  }
  const out: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const start = r * EMBEDDING_DIM;
    out.push(Array.from(Array.prototype.slice.call(data, start, start + EMBEDDING_DIM)));
  }
  return out;
}

/** Embed several texts in a single forward pass. */
export async function generateEmbeddingsFromModel(
  kind: 'passage' | 'query',
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!embeddingPipeline) {
    await initModel();
  }
  if (!embeddingPipeline) return [];

  const inputs = texts.map(t => PREFIX[kind] + t.substring(0, MAX_CONTENT_CHARS));

  const output = await embeddingPipeline!(inputs, {
    pooling: 'mean',
    normalize: true,
  });

  return sliceBatchOutput(output.data, texts.length);
}
```

`EMBEDDING_DIM` is already imported in this file. Do not change `generateEmbeddingFromModel`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/core/embeddings-model.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Verify batching against the real model**

This confirms the tensor-shape assumption on the actual model rather than a mock. Create `tmp-batch-check.ts` **in the repo root** (dependency resolution fails from `/tmp`):

```typescript
import { generateEmbeddingsFromModel } from './src/core/embeddings-model.js';
const vecs = await generateEmbeddingsFromModel('passage', ['alpha', 'beta', 'gamma']);
console.log('ROWS', vecs.length, 'DIM', vecs[0].length);
```

Run: `bun run ./tmp-batch-check.ts`
Expected: `ROWS 3 DIM 384`
Then: `rm -f ./tmp-batch-check.ts`

- [ ] **Step 6: Commit**

```bash
git add src/core/embeddings-model.ts src/core/embeddings-model.test.ts
git commit -m "feat(embeddings): add batch inference"
```

---

### Task 4: Error policy and concurrency in the public embedding API

The core of the fix. `embeddings.ts` stops collapsing failure into `null`, so `sync.ts`'s existing retry guard can see it, and the rate limiter is replaced by the Task 1 semaphore.

**Files:**
- Modify: `src/core/embeddings.ts`
- Modify: `src/core/embeddings.test.ts` (one existing test changes meaning)
- Test: `src/core/embeddings.test.ts`

**Interfaces:**
- Consumes: `Semaphore`/`withSemaphore` (Task 1); `EmbeddingConfig`/`DEFAULT_EMBEDDING_MAX_CONCURRENCY` (Task 2); `generateEmbeddingsFromModel` (Task 3)
- Produces:
  - `export class EmbeddingError extends Error`
  - `export async function embedPassageBatch(texts: string[]): Promise<number[][]>`
  - `export function __resetEmbeddingConcurrencyForTests(): void`
  - `embedPassage`/`embedQuery` keep their signatures but now **throw** `EmbeddingError` on failure instead of returning `null`. They still return `null` when disabled.

- [ ] **Step 1: Write the failing test**

In `src/core/embeddings.test.ts`, **replace** the existing test named `'returns null on model error'` with the tests below, and add the new imports (`EmbeddingError`, `embedPassageBatch`, `__resetEmbeddingConcurrencyForTests`) to the existing import from `./embeddings.js`:

```typescript
  test('embedPassage throws EmbeddingError on model failure', async () => {
    shouldFail = true;
    await expect(embedPassage('hello')).rejects.toThrow(EmbeddingError);
  });

  test('embedQuery throws EmbeddingError on model failure', async () => {
    shouldFail = true;
    await expect(embedQuery('hello')).rejects.toThrow(EmbeddingError);
  });

  test('EmbeddingError message names the failing kind', async () => {
    shouldFail = true;
    await expect(embedPassage('hello')).rejects.toThrow(/passage/);
  });
```

Then add a new `describe` block for the batch path and the concurrency cap:

```typescript
describe('embedPassageBatch()', () => {
  let calls: number;
  let peak: number;
  let active: number;

  beforeEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    calls = 0;
    peak = 0;
    active = 0;
    __setLoadConfigForTests(() => ({
      provider: 'gemini',
      apiKey: 'test',
      embedding: { maxConcurrency: 2 },
    }) as any);
    __resetEmbeddingConcurrencyForTests();
    __setBatchModelForTests(async (_kind, texts) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
      return texts.map(() => mockEmbedding);
    });
  });

  afterEach(() => {
    __setBatchModelForTests(null);
    __setLoadConfigForTests(null);
    __resetEmbeddingConcurrencyForTests();
  });

  test('embeds N texts with one model call', async () => {
    const result = await embedPassageBatch(['a', 'b', 'c']);
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(EMBEDDING_DIM);
    expect(calls).toBe(1);
  });

  test('returns an empty array for no texts without calling the model', async () => {
    expect(await embedPassageBatch([])).toEqual([]);
    expect(calls).toBe(0);
  });

  test('caps concurrent batches at maxConcurrency', async () => {
    await Promise.all(Array.from({ length: 6 }, () => embedPassageBatch(['x'])));
    expect(peak).toBe(2);
  });

  test('throws EmbeddingError when the model returns the wrong count', async () => {
    __setBatchModelForTests(async () => [mockEmbedding]);
    await expect(embedPassageBatch(['a', 'b'])).rejects.toThrow(EmbeddingError);
  });

  test('returns empty when embeddings are disabled', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    expect(await embedPassageBatch(['a'])).toEqual([]);
    expect(calls).toBe(0);
  });
});
```

This requires one more test hook, `__setBatchModelForTests`, added in Step 3. Add it to the import list as well.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/core/embeddings.test.ts`
Expected: FAIL — `EmbeddingError`, `embedPassageBatch`, `__setBatchModelForTests`, and `__resetEmbeddingConcurrencyForTests` are not exported

- [ ] **Step 3: Write the implementation**

Rewrite `src/core/embeddings.ts`. Keep the existing header comment and the `__setModelForTests` hook; the changes are the new error class, the semaphore, the batch path, and throwing instead of returning `null`.

```typescript
/**
 * In-process embedding generation via HuggingFace transformers.
 * Model is lazy-loaded on first use and stays in memory.
 */
import {
  initModel as defaultInitModel,
  generateEmbeddingFromModel as defaultGenerate,
  generateEmbeddingsFromModel as defaultGenerateBatch,
} from './embeddings-model.js';
import { log } from './logger.js';
import { Semaphore, withSemaphore } from './semaphore.js';
import { loadConfig, DEFAULT_EMBEDDING_MAX_CONCURRENCY } from './llm/config.js';

type EmbeddingKind = 'passage' | 'query';
type GenerateFn = (kind: EmbeddingKind, text: string) => Promise<number[] | null>;
type GenerateBatchFn = (kind: EmbeddingKind, texts: string[]) => Promise<number[][]>;

/**
 * Raised when embedding fails for a reason other than being disabled.
 *
 * This must be an error rather than a null return: sync.ts only withholds an
 * archive file's "fully indexed" marker when a span throws, so a silent null
 * caused extracted facts to be dropped and the file marked complete anyway.
 */
export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

let initModelFn: () => Promise<void> = defaultInitModel;
let generateFn: GenerateFn = defaultGenerate;
let generateBatchFn: GenerateBatchFn = defaultGenerateBatch;

/** Override model functions for testing. Pass null to reset. */
export function __setModelForTests(
  init: (() => Promise<void>) | null,
  generate: GenerateFn | null,
): void {
  initModelFn = init ?? defaultInitModel;
  generateFn = generate ?? defaultGenerate;
}

/** Override the batch model function for testing. Pass null to reset. */
export function __setBatchModelForTests(generate: GenerateBatchFn | null): void {
  generateBatchFn = generate ?? defaultGenerateBatch;
}

let semaphore: Semaphore | null = null;

function getSemaphore(): Semaphore {
  if (!semaphore) {
    const configured = loadConfig()?.embedding?.maxConcurrency;
    semaphore = new Semaphore(configured ?? DEFAULT_EMBEDDING_MAX_CONCURRENCY);
  }
  return semaphore;
}

/** Drop the cached semaphore so a new config takes effect (tests). */
export function __resetEmbeddingConcurrencyForTests(): void {
  semaphore = null;
}

export function isEmbeddingsDisabled(): boolean {
  return process.env.MEMMEM_DISABLE_EMBEDDINGS === 'true';
}

export async function initEmbeddings(): Promise<void> {
  if (isEmbeddingsDisabled()) return;
  await initModelFn();
}

/** Embed text that will be stored as a vector for retrieval. */
export async function embedPassage(text: string): Promise<number[] | null> {
  return run('passage', text);
}

/** Embed a user search query. */
export async function embedQuery(text: string): Promise<number[] | null> {
  return run('query', text);
}

/**
 * Embed several passages in one model call.
 *
 * One forward pass for N texts: measured 65ms for 10 texts versus 395ms for
 * 10 separate calls.
 */
export async function embedPassageBatch(texts: string[]): Promise<number[][]> {
  if (isEmbeddingsDisabled()) return [];
  if (texts.length === 0) return [];

  return withSemaphore(getSemaphore(), async () => {
    let vectors: number[][];
    try {
      vectors = await generateBatchFn('passage', texts);
    } catch (err) {
      throw new EmbeddingError(`batch embedding failed: ${(err as Error).message}`);
    }
    if (vectors.length !== texts.length) {
      throw new EmbeddingError(
        `batch embedding returned ${vectors.length} vectors for ${texts.length} texts`,
      );
    }
    return vectors;
  });
}

async function run(kind: EmbeddingKind, text: string): Promise<number[] | null> {
  if (isEmbeddingsDisabled()) return null;

  return withSemaphore(getSemaphore(), async () => {
    let vector: number[] | null;
    try {
      vector = await generateFn(kind, text);
    } catch (err) {
      throw new EmbeddingError(`embedding failed (${kind}): ${(err as Error).message}`);
    }
    if (!vector) {
      throw new EmbeddingError(`embedding failed (${kind}): model returned no vector`);
    }
    return vector;
  });
}
```

Note what is deliberately gone: the `log.warn`-and-return-`null` catch, and the
`getEmbeddingRateLimiter()` call. Leave `src/core/ratelimiter.ts` untouched —
`getLLMRateLimiter()` is still used by the LLM providers, which are genuinely
metered APIs.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/core/embeddings.test.ts`
Expected: PASS

- [ ] **Step 5: Check for other callers of the removed behavior**

Run: `bun run typecheck`
Expected: errors only in `add.ts` and `search.ts`, which Tasks 5 and 6 fix. If any other file breaks, stop and report it — the plan assumed exactly three callers (`add.ts:50`, `add.ts:97`, `search.ts:53`).

- [ ] **Step 6: Commit**

```bash
git add src/core/embeddings.ts src/core/embeddings.test.ts
git commit -m "fix(embeddings): throw on failure instead of dropping the vector

Returning null let add.ts discard the extracted fact while sync.ts marked
the archive file fully indexed, so the fact was never re-extracted. 115
such failures in one day.

Also replaces the 0.5rps rate limiter with a concurrency cap: the model
runs in-process on CPU at ~12.6ms per text, so an rps limit added ~96.8
min/day of pure waiting."
```

---

### Task 5: Search degrades gracefully

Search should still return empty results when the embedder is broken — but visibly, not silently.

**Files:**
- Modify: `src/core/memory/search.ts:53`
- Test: `src/core/memory/search.test.ts`

**Interfaces:**
- Consumes: `EmbeddingError` (Task 4)
- Produces: no new exports

- [ ] **Step 1: Write the failing test**

Add to `src/core/memory/search.test.ts`, following the file's existing setup for an in-memory DB and `__setModelForTests`:

```typescript
test('returns empty results when embedding fails', async () => {
  __setModelForTests(async () => {}, async () => { throw new Error('model down'); });
  const { results } = await searchMemories({
    db,
    query: 'anything',
    filters: { user_id: 'local' },
  });
  expect(results).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/core/memory/search.test.ts`
Expected: FAIL — the call rejects with `EmbeddingError` instead of resolving

- [ ] **Step 3: Write the implementation**

In `src/core/memory/search.ts`, add `EmbeddingError` to the existing import from `../embeddings.js`, and replace line 53's bare call:

```typescript
  let embedding: number[] | null;
  try {
    embedding = await embedQuery(query);
  } catch (err) {
    if (!(err instanceof EmbeddingError)) throw err;
    // Search degrades to empty rather than failing: an unavailable embedder
    // should not break the caller. Logged because it is otherwise invisible.
    log.warn('search embedding failed; returning no results', { error: err.message });
    return { results: [] };
  }
  if (!embedding) return { results: [] };
```

Add `import { log } from '../logger.js';` if the file does not already import it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/core/memory/search.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/memory/search.ts src/core/memory/search.test.ts
git commit -m "fix(search): log embedding failure instead of failing silently"
```

---

### Task 6: Batch the ingestion path

`add.ts` currently makes N individual calls. This is where the 18.0 s → 65 ms improvement lands, and where the data-loss fix takes effect.

**Files:**
- Modify: `src/core/memory/add.ts:50` and `:59`
- Test: `src/core/memory/add.test.ts`

**Interfaces:**
- Consumes: `embedPassageBatch`, `EmbeddingError` (Task 4)
- Produces: no new exports; `addMemories()` now rejects on embedding failure

- [ ] **Step 1: Write the failing test**

Add to `src/core/memory/add.test.ts`:

```typescript
test('rejects when embedding fails, so sync can retry the span', async () => {
  __setBatchModelForTests(async () => { throw new Error('model down'); });
  await expect(addMemories({
    db,
    provider: fakeProvider([{ text: 'User prefers TypeScript' }]),
    messages: [{ role: 'user', content: 'I prefer TypeScript' }],
    filters: { user_id: 'local' },
    sessionKey: 'test',
  })).rejects.toThrow(EmbeddingError);
});

test('embeds all extracted facts in one batch call', async () => {
  let calls = 0;
  __setBatchModelForTests(async (_kind, texts) => {
    calls++;
    return texts.map(() => EMB());
  });
  const result = await addMemories({
    db,
    provider: fakeProvider([
      { text: 'Fact one' },
      { text: 'Fact two' },
      { text: 'Fact three' },
    ]),
    messages: [{ role: 'user', content: 'three things' }],
    filters: { user_id: 'local' },
    sessionKey: 'test',
  });
  expect(result.results).toHaveLength(3);
  expect(calls).toBe(1);
});
```

Adapt `fakeProvider(...)` to whatever helper the file already uses to stub extraction output; do not invent a new one. Add `__setBatchModelForTests` and `EmbeddingError` to the imports from `../embeddings.js`, and reset the hook in the file's existing `afterEach` with `__setBatchModelForTests(null)`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/core/memory/add.test.ts`
Expected: FAIL — `addMemories` resolves with `{ results: [] }` instead of rejecting, and the batch hook is never called

- [ ] **Step 3: Write the implementation**

In `src/core/memory/add.ts`, change the import on line 5 to bring in the batch function:

```typescript
import { embedPassageBatch, embedQuery } from '../embeddings.js';
```

Replace line 50:

```typescript
  // Phase 3: batch embed. One forward pass for the whole span's facts.
  const embeddings = await embedPassageBatch(extracted.map(m => m.text));
```

Then in the loop below it, drop the now-unreachable null guard. The loop becomes:

```typescript
  const rows: NewMemory[] = [];
  for (const [i, m] of extracted.entries()) {
    rows.push({
      id: randomUUID(),
      memory: m.text,
      metadata: {
        ...metadata,
        ...filters,
        attributed_to: m.attributed_to,
      },
      embedding: embeddings[i],
    });
  }
```

`embedPassageBatch` guarantees one vector per input or throws, so `embeddings[i]` is always present. When embeddings are disabled it returns `[]`; guard that case by returning early right after the batch call:

```typescript
  if (embeddings.length === 0) return { results: [] };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/core/memory/add.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/memory/add.ts src/core/memory/add.test.ts
git commit -m "perf(add): embed a span's facts in one batch call"
```

---

### Task 7: Sync retries files whose embedding failed

Proves the end-to-end goal: an embedding failure must leave the archive file un-marked so the next sync reconsiders it. `sync.ts` needs no code change — this task verifies the existing guard now catches embedding failures too.

**Files:**
- Test: `src/cli/sync.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4 and 6
- Produces: nothing

- [ ] **Step 1: Write the failing test**

`src/cli/sync.test.ts` already has `'does not mark a file fully indexed when one of its spans fails extraction'` (line 257). Add its embedding-failure sibling directly after it, reusing that test's fixture setup verbatim except for the failure injection:

```typescript
test('does not mark a file fully indexed when embedding fails', async () => {
  // Same shape as the extraction-failure test above, but the failure comes
  // from the embedder rather than the LLM. Before EmbeddingError, this path
  // silently dropped the facts and marked the file complete.
  __setBatchModelForTests(async () => { throw new Error('model down'); });

  // ... reuse the sibling test's archive fixture and syncArchives(...) call ...

  const mtime = getArchiveIndexMtime(db, archivePath);
  expect(mtime).toBeUndefined();
});
```

Import `__setBatchModelForTests` from `../core/embeddings.js` and reset it in the file's existing `afterEach`. Use whatever accessor the sibling test uses to read the index state; do not add a new one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/cli/sync.test.ts`
Expected: FAIL — before Task 4/6 land this would record an mtime. If it passes immediately, verify the test actually injects the failure (a mis-wired mock is the likely cause).

- [ ] **Step 3: Confirm no production change is needed**

`src/cli/sync.ts:192` already withholds the mtime when `hadFailure` is set, and its per-span `catch` at line 175 now receives `EmbeddingError` because `addMemories()` rejects. Make no edit to `sync.ts` in this task.

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/sync.test.ts
git commit -m "test(sync): cover retry after embedding failure"
```

---

### Task 8: Re-derive the extraction budget

`EXTRACTION_BUDGET_PER_SYNC = 20` was sized against rate-limited throughput ("~25s/record"). With embedding no longer a factor, the bound is LLM latency alone. The backlog grew 1892 → 7214 in one day under the old value.

**Files:**
- Modify: `src/cli/sync.ts:18-25`
- Test: `src/cli/sync.test.ts` (existing budget test must keep passing)

**Interfaces:**
- Consumes: nothing
- Produces: `EXTRACTION_BUDGET_PER_SYNC` changes value from `20` to `60`

- [ ] **Step 1: Check the existing budget test does not hardcode 20**

Run: `bun test src/cli/sync.test.ts -t "caps extractions per sync"`
Expected: PASS. Then read that test (line 208). If it hardcodes `20`, change it to import and use `EXTRACTION_BUDGET_PER_SYNC` so it tests the behavior rather than the constant. If it already passes an explicit budget through options, leave it alone.

- [ ] **Step 2: Update the constant and its rationale**

In `src/cli/sync.ts`, replace lines 18-25 with:

```typescript
/**
 * Maximum LLM extractions a single sync run may perform. Caps how long the sync
 * lock is held so it always finishes; leftover spans are indexed by later syncs.
 *
 * Sized against LLM latency alone. Embedding used to dominate this budget (a
 * 0.5rps rate limiter cost ~2s per extracted fact); it is now a concurrency-
 * capped batch call measured at 65ms for 10 facts, so it no longer factors in.
 *
 * Measured LLM latency over a real sync run: mean 53s per span, max 85s. At that
 * rate 12 spans is ~10 minutes, which is the lock-hold ceiling the previous
 * value of 20 was also aiming for (it just mis-estimated the per-span cost at
 * 25s). Raising this further does not help throughput — it only holds the lock
 * longer and makes concurrent syncs skip.
 */
export const EXTRACTION_BUDGET_PER_SYNC = 12;
```

**Note (written during implementation):** this step originally prescribed **60**, based on an
estimate of 8-35 s per span. Measurement contradicted it — mean 53.1 s, max 85.2 s — which puts
60 spans at ~53 min of lock hold. A day's log also showed 43 sync runs against 277
"sync already running; skipping" events (6:1), so a longer hold worsens the backlog it was meant
to fix. Implemented as **12**.

- [ ] **Step 3: Run the suite**

Run: `bun test src/cli/sync.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/cli/sync.ts src/cli/sync.test.ts
git commit -m "perf(sync): re-derive extraction budget from measured LLM latency

The old value of 20 was derived from rate-limited embedding throughput.
Embedding is no longer part of that cost, but the LLM half was also
mis-measured: a real sync run shows mean 53s per span, max 85s. Today's
log shows sync ran 43 times but was blocked by the lock 277 times, so a
longer hold makes the backlog worse. 12 spans is ~10 min."
```

---

### Task 9: Full verification and rebuild

**Files:**
- Modify: `dist/cli-internal.mjs`, `dist/mcp-server.mjs`, `bin/memmem` (build output)

**Interfaces:**
- Consumes: all prior tasks
- Produces: rebuilt bundles

- [ ] **Step 1: Run the full check**

```bash
bun test && bun run typecheck && bun run build
```
Expected: all pass.

- [ ] **Step 2: Measure the ingestion path against the baseline**

Create `tmp-bench.ts` in the repo root:

```typescript
import { initModel } from './src/core/embeddings-model.js';
import { embedPassageBatch } from './src/core/embeddings.js';
await initModel();
const texts = Array.from({ length: 10 }, (_, i) => `User prefers TypeScript for project ${i}`);
const t = Date.now();
await embedPassageBatch(texts);
console.log(`10 facts: ${Date.now() - t}ms  (baseline was 18000ms)`);
```

Run: `bun run ./tmp-bench.ts`
Expected: well under 1000 ms (measured floor ~65 ms).
Then: `rm -f ./tmp-bench.ts`

- [ ] **Step 3: Run a real sync and check the log**

```bash
bun run cli sync
```

Then inspect today's log:

```bash
grep -c "embedding failed" ~/.config/memmem/logs/$(date +%F).log
grep '"remaining"' ~/.config/memmem/logs/$(date +%F).log | tail -2
```

Expected: zero new `embedding failed` lines from this run, and `remaining` lower than the prior run's value. If `embedding failed` still appears, the underlying model/cache problem is real and now correctly surfaces — report the message rather than suppressing it.

- [ ] **Step 4: Reclaim disk (optional, from the spec's incidental cleanup)**

```bash
rm -rf /Users/jito.hello/dev/wooto/memmem/.cache
rm -f ~/.config/memmem/models/Xenova/multilingual-e5-small/onnx/model.onnx
```

The first is a 514 MB stray relative cache left over from before commit `846f056` pinned an absolute cache dir. The second is the 448 MB fp32 weights, never loaded under `dtype: 'fp16'`. Both are caches; deleting them is safe. Re-run `bun test src/core/embeddings-model.test.ts` afterward to confirm the model still loads.

- [ ] **Step 5: Commit the rebuilt bundles**

```bash
git add dist bin
git commit -m "chore(build): rebuild bundles"
```

Note: `dist/` output is nondeterministic between builds. If the only diff is noise unrelated to these changes, `git checkout` the untouched files rather than committing churn.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Design 1 — distinguish disabled from failed | Task 4 (+ Task 5 for search's catch) |
| Design 2 — concurrency cap replaces rate limiter | Tasks 1, 2, 4 |
| Design 3 — native batch embedding | Tasks 3, 4, 6 |
| Design 4 — raise `EXTRACTION_BUDGET_PER_SYNC` | Task 8 |
| Incidental cleanup (`./.cache`, fp32 weights) | Task 9 Step 4 |
| Verification 1 — unit tests | Tasks 1, 3, 4 |
| Verification 2 — data-loss regression in `add` | Task 6 |
| Verification 3 — sync retry | Task 7 |
| Verification 4 — test/typecheck/build | Task 9 Step 1 |
| Verification 5 — end-to-end measurement | Task 9 Steps 2-3 |

No gaps.

**Type consistency:** `EmbeddingError` (Task 4) is consumed by Tasks 5, 6, 7 under that exact name. `embedPassageBatch(texts: string[]): Promise<number[][]>` is defined in Task 4 and called in Task 6. `generateEmbeddingsFromModel(kind, texts)` is defined in Task 3 and wired as `defaultGenerateBatch` in Task 4. `sliceBatchOutput(data, rows)` is internal to Task 3. `Semaphore`/`withSemaphore` (Task 1) are used only in Task 4. `DEFAULT_EMBEDDING_MAX_CONCURRENCY` (Task 2) is read in Task 4. `__setBatchModelForTests` is introduced in Task 4 and reused by Tasks 6 and 7.

**Risk noted for the executor:** Tasks 4-6 must land together for the suite to be green — Task 4 alone leaves `add.ts`/`search.ts` type-broken. Task 4's Step 5 makes that explicit rather than letting it surprise the implementer.
