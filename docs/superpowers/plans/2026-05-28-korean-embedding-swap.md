# Korean Embedding Model Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap the embedding model from `Supabase/gte-small` to `dragonkue/multilingual-e5-small-ko-v2` to improve Korean retrieval, while reshaping the embedding API into `embedPassage` / `embedQuery` so e5's required prefixes are applied correctly.

**Architecture:**
- The model is loaded in-process via `@huggingface/transformers` (Transformers.js / ONNX runtime). New model has the same parameter count (33M) and dimension (384), so the database schema does not change.
- Public API splits into two functions: `embedPassage(text)` for indexing, `embedQuery(text)` for search. The e5 `passage:` / `query:` prefix is applied inside `embeddings-model.ts` only. Existing rate limiter, disabled flag, and error handling are preserved in a shared `run(kind, text)` helper.
- `CURRENT_EMBEDDING_VERSION` bumps from 1 to 2. The next `sync` (which currently re-indexes every archive file) naturally re-embeds everything with the new model.

**Tech Stack:** TypeScript, Bun, `@huggingface/transformers` (ONNX runtime), `sqlite-vec`, `bun test`.

**Reference spec:** `docs/superpowers/specs/2026-05-28-korean-embedding-swap-design.md`

---

## File Structure

**Modify:**
- `src/core/embeddings.ts` — public API: `embedPassage`, `embedQuery`, `__setModelForTests` (new signature)
- `src/core/embeddings-model.ts` — model ID, e5 PREFIX table, new `generateEmbeddingFromModel(kind, text)` signature
- `src/core/db.ts:17` — bump `CURRENT_EMBEDDING_VERSION` to 2
- `src/core/indexer.ts:4,35` — replace `generateEmbedding` with `embedPassage`
- `src/core/search.ts:2,174` — replace `generateEmbedding` with `embedQuery`
- `src/core/embeddings.test.ts` — update mocks for new signature, add prefix assertion tests
- `src/core/indexer.test.ts` — update `__setModelForTests` mock signature
- `src/core/search.test.ts` — update `__setModelForTests` mock signature
- `src/cli/sync.test.ts` — update `__setModelForTests` mock signature
- `CLAUDE.md:36` — update embeddings.ts description from "gte-small" to new model

**Create:** none.

**Delete:** none.

---

## Task 1: Update the model loader to accept a `kind` and apply e5 prefix

**Files:**
- Modify: `src/core/embeddings-model.ts` (whole file)

The model layer becomes prefix-aware. The model ID swaps to `dragonkue/multilingual-e5-small-ko-v2`. The signature changes to `generateEmbeddingFromModel(kind, text)`. The PREFIX table is the single source of truth for e5 prefix strings.

- [ ] **Step 1: Replace the contents of `src/core/embeddings-model.ts`**

Rewrite the file. The model name, prefix table, signature, and `initModel`'s log message all change in lockstep. Show the full new contents:

```ts
/**
 * In-process embedding model loading via HuggingFace transformers.
 * Lazy-loaded singleton: first call to initModel() loads the model.
 * Uses dynamic import to avoid loading @huggingface/transformers (and its
 * native dependency `sharp`) at module load time.
 */
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

let embeddingPipeline: FeatureExtractionPipeline | null = null;

const PREFIX = {
  passage: 'passage: ',
  query: 'query: ',
} as const;

const MAX_CONTENT_CHARS = 8000;

export async function initModel(): Promise<void> {
  if (!embeddingPipeline) {
    const { pipeline, env } = await import('@huggingface/transformers');
    console.log('Loading embedding model (first run may take time)...');
    env.cacheDir = './.cache';
    embeddingPipeline = await pipeline(
      'feature-extraction',
      'dragonkue/multilingual-e5-small-ko-v2',
      { dtype: 'fp16' } as any
    );
    console.log('Embedding model loaded');
  }
}

export async function generateEmbeddingFromModel(
  kind: 'passage' | 'query',
  text: string,
): Promise<number[] | null> {
  if (!embeddingPipeline) {
    await initModel();
  }
  if (!embeddingPipeline) return null;

  const truncated = text.substring(0, MAX_CONTENT_CHARS);
  const input = PREFIX[kind] + truncated;

  const output = await embeddingPipeline!(input, {
    pooling: 'mean',
    normalize: true,
  });

  return Array.from(output.data);
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bun run typecheck`
Expected: PASS (`embeddings.ts` will not compile yet — see Task 2 — but `embeddings-model.ts` compiles in isolation if you check it as a single file. The full project typecheck will fail until Task 2 lands. That is expected; do not commit yet.)

This task does not commit on its own. It commits together with Task 2 because the public API in `embeddings.ts` must compile against this new signature.

---

## Task 2: Replace `generateEmbedding` with `embedPassage` / `embedQuery`

**Files:**
- Modify: `src/core/embeddings.ts` (whole file)
- Modify: `src/core/indexer.ts:4,35`
- Modify: `src/core/search.ts:2,174`

The public API splits in two. Both wrap a shared `run(kind, text)` helper. The test override now receives a `(kind, text)` pair.

- [ ] **Step 1: Replace the contents of `src/core/embeddings.ts`**

Rewrite the file. The new export shape is `embedPassage`, `embedQuery`, plus `__setModelForTests` with an updated signature.

```ts
/**
 * In-process embedding generation via HuggingFace transformers.
 * Model is lazy-loaded on first use and stays in memory.
 */
import { initModel as defaultInitModel, generateEmbeddingFromModel as defaultGenerate } from './embeddings-model.js';
import { getEmbeddingRateLimiter } from './ratelimiter.js';

type EmbeddingKind = 'passage' | 'query';
type GenerateFn = (kind: EmbeddingKind, text: string) => Promise<number[] | null>;

let initModelFn: () => Promise<void> = defaultInitModel;
let generateFn: GenerateFn = defaultGenerate;

/** Override model functions for testing. Pass null to reset. */
export function __setModelForTests(
  init: (() => Promise<void>) | null,
  generate: GenerateFn | null,
): void {
  initModelFn = init ?? defaultInitModel;
  generateFn = generate ?? defaultGenerate;
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

async function run(kind: EmbeddingKind, text: string): Promise<number[] | null> {
  if (isEmbeddingsDisabled()) return null;
  try {
    await getEmbeddingRateLimiter().acquire();
    return await generateFn(kind, text);
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Update `src/core/indexer.ts` to use `embedPassage`**

Change the import (line 4) and the call site (line 35).

Replace the line:
```ts
import { generateEmbedding } from './embeddings.js';
```
with:
```ts
import { embedPassage } from './embeddings.js';
```

Replace the line:
```ts
    embeddings.push(await generateEmbedding(exchange.embeddingText));
```
with:
```ts
    embeddings.push(await embedPassage(exchange.embeddingText));
```

- [ ] **Step 3: Update `src/core/search.ts` to use `embedQuery`**

Change the import (line 2) and the call site (line 174).

Replace the line:
```ts
import { generateEmbedding } from './embeddings.js';
```
with:
```ts
import { embedQuery } from './embeddings.js';
```

Replace the line:
```ts
  const embedding = await generateEmbedding(query);
```
with:
```ts
  const embedding = await embedQuery(query);
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS for `embeddings.ts`, `embeddings-model.ts`, `indexer.ts`, `search.ts`. Other test files (`embeddings.test.ts`, `indexer.test.ts`, `search.test.ts`, `sync.test.ts`) will FAIL because their mocks still use the old `(init, generate-without-kind)` shape — that is expected and handled in Task 4.

Do not commit yet — tests still fail.

---

## Task 3: Bump `CURRENT_EMBEDDING_VERSION`

**Files:**
- Modify: `src/core/db.ts:17`

- [ ] **Step 1: Bump the version constant**

Replace the line:
```ts
export const CURRENT_EMBEDDING_VERSION = 1;
```
with:
```ts
export const CURRENT_EMBEDDING_VERSION = 2;
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS for all production source files. Tests still fail (see Task 4).

---

## Task 4: Update test mocks to the new `(kind, text)` signature

**Files:**
- Modify: `src/core/embeddings.test.ts` (whole file rewrite is simplest)
- Modify: `src/core/indexer.test.ts:27,52,86,113`
- Modify: `src/core/search.test.ts:18,38,56,73,92,119,145,162,184`
- Modify: `src/cli/sync.test.ts:188`

The mock signature changes from `async () => embedding` (zero-arg) to `async (_kind, _text) => embedding`. Most existing mocks ignore the text, so this is a parameter-list change only.

`embeddings.test.ts` is special — it tested `generateEmbedding(text)` directly. It must be rewritten to test `embedPassage` and `embedQuery` and to verify that the mock receives the correct `kind`.

- [ ] **Step 1: Replace the contents of `src/core/embeddings.test.ts`**

Rewrite the file. The new test suite uses `embedPassage` and `embedQuery` and adds a `kind`-routing assertion.

```ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { EMBEDDING_DIM } from './constants.js';
import { resetRateLimiters, __setLoadConfigForTests } from './ratelimiter.js';
import { __setModelForTests, isEmbeddingsDisabled, initEmbeddings, embedPassage, embedQuery } from './embeddings.js';

const mockEmbedding = Array.from({ length: EMBEDDING_DIM }, (_, i) => i * 0.001);
let shouldFail = false;
let lastKind: 'passage' | 'query' | null = null;
let lastText: string | null = null;

const mockInit = async () => {
  if (shouldFail) throw new Error('model load failed');
};
const mockGenerate = async (kind: 'passage' | 'query', text: string) => {
  if (shouldFail) throw new Error('generation failed');
  lastKind = kind;
  lastText = text;
  return mockEmbedding;
};

describe('isEmbeddingsDisabled()', () => {
  afterEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
  });

  test('returns false by default', () => {
    expect(isEmbeddingsDisabled()).toBe(false);
  });

  test('returns true when MEMMEM_DISABLE_EMBEDDINGS=true', () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    expect(isEmbeddingsDisabled()).toBe(true);
  });
});

describe('embedPassage() and embedQuery()', () => {
  beforeEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
    lastKind = null;
    lastText = null;
    __setModelForTests(mockInit, mockGenerate);
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
    __setModelForTests(null, null);
    __setLoadConfigForTests(null);
    resetRateLimiters();
  });

  test('embedPassage returns null when disabled', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    expect(await embedPassage('test')).toBeNull();
  });

  test('embedQuery returns null when disabled', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    expect(await embedQuery('test')).toBeNull();
  });

  test('embedPassage routes with kind="passage"', async () => {
    const result = await embedPassage('hello world');
    expect(result).toEqual(mockEmbedding);
    expect(lastKind).toBe('passage');
    expect(lastText).toBe('hello world');
  });

  test('embedQuery routes with kind="query"', async () => {
    const result = await embedQuery('hello world');
    expect(result).toEqual(mockEmbedding);
    expect(lastKind).toBe('query');
    expect(lastText).toBe('hello world');
  });

  test('returns null on model error', async () => {
    shouldFail = true;
    expect(await embedPassage('hello')).toBeNull();
    expect(await embedQuery('hello')).toBeNull();
  });

  test('handles concurrent passage and query requests', async () => {
    const results = await Promise.all([
      embedPassage('text 1'),
      embedQuery('text 2'),
      embedPassage('text 3'),
    ]);
    expect(results).toHaveLength(3);
    results.forEach(r => expect(r).toHaveLength(EMBEDDING_DIM));
  });
});

describe('initEmbeddings()', () => {
  beforeEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
    __setModelForTests(mockInit, mockGenerate);
  });

  afterEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
    __setModelForTests(null, null);
  });

  test('no-ops when disabled', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    await expect(initEmbeddings()).resolves.toBeUndefined();
  });

  test('calls initModel when enabled', async () => {
    await expect(initEmbeddings()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Update `src/core/indexer.test.ts` mock signatures**

Four `__setModelForTests` calls in this file pass a generator function. They must take `(_kind, _text)` arguments now (even though they ignore both).

Replace at line 27:
```ts
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, (_, i) => i / 384));
```
with:
```ts
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, (_, i) => i / 384));
```

Replace at line 52 (the call that uses a closure for `embeddingCall`):
```ts
    __setModelForTests(async () => {}, async () => {
```
with:
```ts
    __setModelForTests(async () => {}, async (_kind, _text) => {
```

Replace at line 86:
```ts
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));
```
with:
```ts
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));
```

Replace at line 113:
```ts
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));
```
with:
```ts
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));
```

- [ ] **Step 3: Update `src/core/search.test.ts` mock signatures**

This file has nine `__setModelForTests` calls. Replace every occurrence of the zero-arg generator form with the two-arg form.

At lines 18, 38, 56, 73, 92, 145, 162, 184 the pattern is:
```ts
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));
```
Replace with:
```ts
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));
```

At line 119 the form is different:
```ts
    __setModelForTests(async () => {}, async (text: string) => {
```
Replace with:
```ts
    __setModelForTests(async () => {}, async (_kind, text: string) => {
```

- [ ] **Step 4: Update `src/cli/sync.test.ts` mock signature**

At line 188:
```ts
  __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));
```
Replace with:
```ts
  __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));
```

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: ALL TESTS PASS.

If a test still fails, the most likely cause is a missed mock call site — re-run `grep -rn "__setModelForTests" src/` and confirm every non-null call passes `(_kind, _text)`.

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Run the build**

Run: `bun run build`
Expected: PASS. The build script bundles `src/cli/main.ts` and `src/mcp/server.ts` into `dist/`.

---

## Task 5: Update CLAUDE.md to reflect the new model

**Files:**
- Modify: `CLAUDE.md:36`

- [ ] **Step 1: Replace the embeddings.ts description**

Replace the line:
```markdown
| `src/core/embeddings.ts` | gte-small embeddings (384-dim, fp16) |
```
with:
```markdown
| `src/core/embeddings.ts` | multilingual-e5-small-ko-v2 embeddings (384-dim, fp16) with passage/query prefix routing |
```

---

## Task 6: Commit all production and test changes together

The model swap, API split, version bump, and test mock updates form one atomic change. Committing partial state leaves the repo broken (production code compiled against new API, tests still on old signature). Group everything into one commit.

- [ ] **Step 1: Stage everything from Tasks 1–5**

```bash
git add \
  src/core/embeddings-model.ts \
  src/core/embeddings.ts \
  src/core/embeddings.test.ts \
  src/core/db.ts \
  src/core/indexer.ts \
  src/core/search.ts \
  src/core/indexer.test.ts \
  src/core/search.test.ts \
  src/cli/sync.test.ts \
  CLAUDE.md
```

- [ ] **Step 2: Verify the staged diff has only expected changes**

Run: `git diff --cached --stat`
Expected output (file count and line ranges may vary slightly):
```
 CLAUDE.md                       |  2 +-
 src/cli/sync.test.ts            |  2 +-
 src/core/db.ts                  |  2 +-
 src/core/embeddings-model.ts    | (rewrite)
 src/core/embeddings.test.ts     | (rewrite)
 src/core/embeddings.ts          | (rewrite)
 src/core/indexer.test.ts        |  8 ++++----
 src/core/indexer.ts             |  4 ++--
 src/core/search.test.ts         | 18 +++++++++---------
 src/core/search.ts              |  4 ++--
```

No unrelated files. No `package.json`, no lockfiles, no `dist/`.

- [ ] **Step 3: Run the full verification chain one more time**

Run all three sequentially so the commit captures a known-good state:

```bash
bun run typecheck && bun test && bun run build
```

Expected: all three pass. If any fail, fix in place — do not commit partial state.

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: swap embedding model to multilingual-e5-small-ko-v2

Replace Supabase/gte-small with dragonkue/multilingual-e5-small-ko-v2
to improve Korean retrieval. Same 33M params and 384-dim, so DB
schema is unchanged. Split generateEmbedding into embedPassage and
embedQuery so e5's required passage:/query: prefix is applied at the
right call sites. Bump CURRENT_EMBEDDING_VERSION to 2 so existing
exchanges are tagged with the new model on the next sync (which
already re-indexes every archive file).
EOF
)"
```

- [ ] **Step 5: Confirm the commit**

Run: `git log -1 --stat`
Expected: One commit showing the file list from Step 2.

---

## Task 7: Manual smoke test against real transcripts

Final gate after the commit. Run real sync, run a Korean query, verify DB version. No rollback steps — if the model fails to load, surface the error to the user.

- [ ] **Step 1: Run a real sync**

Run: `bun dist/cli.mjs sync`

Expected output:
- A line `Loading embedding model (first run may take time)...` followed (after the model download, which may take a minute on first run) by `Embedding model loaded`.
- A final line of the form `Done. copied=<N> indexed=<M> skipped=0`.

- [ ] **Step 2: Run a Korean search**

Run: `bun dist/cli.mjs search "메모리 누수 디버깅"`
Expected: Returns up to 10 results, each with `archive_path`, `line_start`, `line_end`, snippet. Spot-check that snippets are at least topically related to memory/debugging. (Qualitative.)

- [ ] **Step 3: Run an English search**

Run: `bun dist/cli.mjs search "embedding model swap"`
Expected: Returns results; spot-check that English retrieval still works.

- [ ] **Step 4: Confirm DB version is 2**

Run: `sqlite3 ~/.config/memmem/conversation-index/conversations.db 'SELECT DISTINCT embedding_version FROM exchanges;'`
Expected output: a single line containing `2`.

---

## Self-Review Notes (for the plan author, not the executor)

- Spec coverage: every change called out in `2026-05-28-korean-embedding-swap-design.md` "변경 파일" table is covered by a task. CLAUDE.md update is Task 5. No `sync.ts` change because the revised spec removed it.
- Placeholder scan: no TBD / TODO / "similar to above" remain.
- Type consistency: `EmbeddingKind` is `'passage' | 'query'` everywhere. `GenerateFn = (kind: EmbeddingKind, text: string) => Promise<number[] | null>` matches between `embeddings.ts`, `embeddings-model.ts` exports, and the test mocks.
- Commit grouping: production code and tests are committed together so the repo never lands in a half-broken state.
