# Embedding Throughput and Failure Handling

## Problem

An investigation into "embedding load" found that the assumed cause — model loading — is
negligible, and that the real costs lie elsewhere. All figures below are measured on this
machine (14 cores, 48 GB RAM, Apple Silicon) from `~/.config/memmem/logs/2026-08-11.log` and
direct benchmarks of the production code path.

### Measured baseline

| Quantity | Measured |
| --- | --- |
| Inference, per text | **12.6 ms** |
| Model load, warm page cache | **488 ms** |
| Model load distribution (43 loads/day) | min 389 ms, median 493 ms, mean 2912 ms, max 37810 ms; only 6/43 (14%) exceeded 2 s |
| **Total time loading the model, all day** | **125 s** |
| `add.ts:50` path, 10 facts, via `embedPassage` | **18.0 s** |
| Pure compute for those same 10 facts | **0.126 s** |

### Cost attribution for one day (617 spans, 2905 facts)

| Cause | Waste per day |
| --- | --- |
| **Rate limiter (0.5 rps, burst 1)** | **~5810 s ≈ 96.8 min** |
| All 43 model loads combined | 125 s |
| Actual compute required | 36.6 s |

The rate limiter costs roughly **46x more than all model loading combined**. This excludes
Phase 1's per-span `embedQuery` (617 more calls, ~1234 s of additional waiting).

`~/.config/memmem/config.json` contains no `ratelimit` section, so the
`DEFAULT_EMBEDDING_RPS = 0.5` default in `src/core/ratelimiter.ts` is genuinely active in
production.

### Rejected: a resident embedding server

The initial design direction was a resident Unix-socket embedding server so the model would
load once per machine instead of once per process. The measurements defeat it: the maximum
recoverable cost is 125 s/day, and this project already built, shipped, and then deliberately
deleted that exact architecture on 2026-02-26 (`docs/plans/2026-02-26-ipc-removal-design.md`),
removing ~264 lines of socket client, worker, spawn, retry, idle-timeout, and connection
tracking as excessive "for what is essentially `generateEmbeddingFromModel(text)`".
Reintroducing it to reclaim 2 minutes a day is not justified.

For the record, mem0 v2.0.17 does not solve this either. Its default embedder is the OpenAI
API; its local embedders (`mem0/embeddings/huggingface.py`, `fastembed.py`) load eagerly in
`__init__` with no singleton, cache, warmup, or file locking anywhere in the package. Its only
mitigation is `server/server_state.py`'s module-global `Memory`, and that server is
provisioned for API embedders only (`BUNDLED_EMBEDDER_PROVIDERS = ("openai", "gemini")`).

### Corrected diagnosis of the load-time spikes

The 15.7 s / 15.8 s / 37.8 s load spikes are not cold page cache. The log around the 37.8 s
spike shows the same sync process concurrently scanning 7225 archive files and waiting on a
35 s Gemini call:

```
11:54:11  Indexing 7225 archive files...
11:54:46  [GeminiProvider] Completion successful {"duration":35287}
11:54:46  Loading embedding model ...
11:55:14  sync already running; skipping
11:55:24  Embedding model loaded in 37.8s
```

The contention is self-inflicted by sync's own CPU and IO. A resident server would not remove
it.

### Silent data loss

Separately, embedding failures discard extracted facts and then mark the source file as fully
indexed, so the loss is permanent. 115 such failures occurred in one day:

- 98x `The socket connection was closed unexpectedly ... fetch()` — a network fetch attempted
  despite a populated local cache.
- 17x `Load model from .cache/Xenova/multilingual-e5-small/onnx/model_fp16.onnx failed:
  Protobuf parsing failed.` — a corrupt or partially downloaded file under a *relative*
  `.cache` path. These stop after 08:21, consistent with commit `846f056` pinning an absolute
  cache dir; a stray `./.cache` directory (514 MB) remains in the repo.

The loss path:

```
embeddings.ts     catch -> log.warn -> return null      (does not throw)
add.ts:59         if (!embedding) continue              -> fact discarded
sync.ts:158-185   addMemories() returned normally       -> hadFailure stays false
sync.ts:192       setArchiveIndexMtime(...)             -> file marked complete, never retried
```

`sync.ts:192` already guards against extraction failure — it withholds the mtime marker when
`hadFailure` is set, and its comment notes that re-running spans is safe because of md5 dedup.
Embedding failure escapes that guard because it never surfaces as an error. The LLM cost
(~35 s per span) is paid and the result is dropped.

### Consequence: the sync backlog is losing ground

`EXTRACTION_BUDGET_PER_SYNC = 20` (`src/cli/sync.ts:25`) is derived from the rate-limited
throughput; its own comment says extraction "runs ~25s/record (LLM latency + rate limiting),
so 20 keeps a single sync under ~10 minutes of lock hold." With 20 spans per run, the backlog
grew from 1892 to 7214 over the course of one day, exhausting the budget 31 times. New
conversations accumulate faster than sync drains them.

## Goals

1. Stop silently discarding extracted facts.
2. Remove the rate limiter's ~96.8 min/day of artificial waiting.
3. Embed a batch of facts in one model call instead of N.
4. Raise the per-sync extraction budget so the backlog drains.

Non-goal: reducing model load count. At a 493 ms median and 125 s/day total, it does not merit
architectural change.

## Design

Four changes, all within existing files. No new processes, no new subsystems.

### 1. Distinguish "disabled" from "failed" in `src/core/embeddings.ts`

Today `run()` collapses both into `null`. `MEMMEM_DISABLE_EMBEDDINGS` is set only by tests
(verified: no production code, hook, or config sets it), so in production `null` always means
failure.

Introduce `EmbeddingError` and throw it on failure. Keep returning `null` only for the
genuinely-disabled case.

```typescript
export class EmbeddingError extends Error {}

async function run(kind: EmbeddingKind, text: string): Promise<number[] | null> {
  if (isEmbeddingsDisabled()) return null;
  await acquireEmbeddingSlot();
  try {
    return await generateFn(kind, text);
  } catch (err) {
    throw new EmbeddingError(`embedding failed (${kind}): ${(err as Error).message}`);
  } finally {
    releaseEmbeddingSlot();
  }
}
```

Caller behavior:

- `add.ts` — does not catch. The error propagates to `sync.ts`'s existing per-span `try`, which
  sets `hadFailure`, withholds the mtime marker, and lets the next sync retry the file. This is
  the entire fix for the data loss; no change to `sync.ts` is required.
- `search.ts:53` — catches `EmbeddingError` and returns `{ results: [] }`, preserving today's
  behavior (an unavailable embedder should not fail a search) but logging at `warn` so the
  condition is visible instead of silent.

### 2. Replace the rate limiter with a concurrency cap

A requests-per-second limiter is the wrong instrument for an in-process CPU model: it throttles
work that costs 12.6 ms as though it were a metered network call. Unbounded concurrency is also
wrong, because up to 5 MCP server pairs may embed simultaneously and ONNX runtime is itself
multi-threaded per inference.

Replace `getEmbeddingRateLimiter()` usage in `embeddings.ts` with a semaphore bounding
*concurrent* embedding calls. Default 4.

- Config: `embedding.maxConcurrency` in `~/.config/memmem/config.json`, default 4.
- The existing `ratelimit.embedding` config key is honored only if explicitly set, so anyone
  who deliberately configured a limit keeps it. Absent config, the cap applies.
- `getLLMRateLimiter()` and the `RateLimiter` class stay as they are — LLM providers are real
  metered APIs and genuinely need rps limiting.

Expected effect: the 10-fact case goes from 18.0 s to roughly its compute cost, and the
96.8 min/day of waiting disappears. Combined with change 3, the measured floor for 10 facts is
65 ms.

### 3. Native batch embedding

Add a batch path so N facts cost one model call rather than N.

- `embeddings-model.ts`: add `generateEmbeddingsFromModel(kind, texts: string[])` calling the
  pipeline once with an array input, applying the same prefix and `MAX_CONTENT_CHARS`
  truncation per text, and slicing the returned tensor into one vector per input. Assert output
  count equals input count — mem0's `huggingface.py` does the same arity check.

  Verified against `@huggingface/transformers` 4.2.0: the signature is
  `_call(texts: string | string[], ...)` (`types/pipelines.d.ts:629`), and calling it with 3
  texts returns a tensor with `dims = [3, 384]` and `data.length = 1152`, i.e. contiguous
  384-float rows in input order. Measured speedup: **batch of 10 = 65 ms vs 10 sequential
  calls = 395 ms (6x)**.
- `embeddings.ts`: add `embedPassageBatch(texts: string[]): Promise<number[][]>`, acquiring one
  concurrency slot for the whole batch.
- `add.ts:50` becomes:
  ```typescript
  const embeddings = await embedPassageBatch(extracted.map(m => m.text));
  ```
  `add.ts:59`'s `if (!embedding) continue` is dropped: on success every fact has a vector, and
  on failure the call throws. The `metadata`/`filters` assembly is unchanged.

`add.ts:97`'s single `embedQuery` stays single — it is one call per span by nature.

### 4. Re-derive `EXTRACTION_BUDGET_PER_SYNC`

The budget's stated basis ("~25s/record") no longer holds once the rate limiter is gone; the
remaining per-record cost is LLM latency, provider-bound. The budget exists to bound lock hold
time, which is still a valid concern, so it stays a budget — it is only re-derived.

**Superseded during implementation.** This section originally prescribed raising 20 to **60**,
on an estimate of 8–35 s per span. A real sync run measured **mean 53.1 s per span, max 85.2 s**,
which puts 60 spans at ~53 minutes of lock hold, not ~10. Worse, a day's production log shows
sync ran 43 times but hit "sync already running; skipping" **277 times** — a 6:1 skip ratio. The
system is skip-dominated, so lengthening each hold reduces how many sync triggers find an idle
lock, which is the opposite of the backlog goal cited here.

Implemented value: **12** (~10 minutes at measured latency), down from 20. Backlog throughput is
bound by provider latency; this constant cannot fix it. A wall-clock bound would adapt better to
the 8–85 s spread than any fixed count, but that is a new stopping condition rather than a
constant swap — left as follow-up.

This tightens the loop with change 1: because embedding failures now withhold the mtime marker,
a systematically broken embedder makes syncs re-process files instead of advancing. That is the
correct behavior (no data is lost), and it is visible in the `failed` stat and the logs.

### Incidental cleanup

Delete the stray relative cache directory `./.cache` (514 MB, gitignored, left over from before
`846f056`), and the unused fp32 `model.onnx` (448 MB) in the model cache — `dtype: 'fp16'`
means only `model_fp16.onnx` (224 MB) is ever loaded. Neither is referenced by code; both are
pure disk reclamation and are listed here so the work is recorded, not to imply a code change.

## Verification

Each goal has a falsifiable check.

1. **Unit tests, before implementation** (`src/core/embeddings.test.ts`):
   - `embedPassage` throws `EmbeddingError` when the model fails (replaces the existing
     "returns null on model error" test for the passage case).
   - `embedPassage`/`embedQuery` still return `null` when `MEMMEM_DISABLE_EMBEDDINGS=true`.
   - `embedPassageBatch` returns one vector per input, in input order, from a single mocked
     model call (assert the mock was invoked once).
   - `embedPassageBatch` throws `EmbeddingError` if the model returns a mismatched count.
   - Concurrency cap: with `maxConcurrency = 2`, a mocked generator that records peak
     concurrent invocations never observes more than 2.
2. **Data-loss regression test** (`src/core/memory/add.test.ts`): with a failing embedder,
   `addMemories()` rejects rather than returning `{ results: [] }`.
3. **Sync retry test** (`src/cli/sync.test.ts`): with a failing embedder, sync does not write
   an `archive_index_state` mtime for the affected file, so a second run reconsiders it.
4. `bun test`, `bun run typecheck`, `bun run build` all pass.
5. **End-to-end measurement**, comparing against the recorded baseline above:
   - Re-run the 10-fact benchmark through the real `add.ts` path: expect < 1 s (was 18.0 s).
   - Run one real `memmem sync` and confirm from the log: zero `embedding failed` lines,
     `memoriesAdded` > 0, and `remaining` lower than the previous run's.

## Risks

- **Throwing changes sync's completion semantics.** A persistently broken embedder now blocks
  files from being marked indexed, so syncs will repeat work instead of advancing. This is
  intended — it trades throughput for not losing data — and md5 dedup makes the repetition
  harmless. It is visible via the `failed` stat.
- **Concurrency of 4 on a weaker machine.** The default is tuned against 14 cores. It is
  configurable, and 4 concurrent 12.6 ms inferences is a small load even on 4 cores.
- **Batch input size.** A span can yield many facts; a single batch call holds more memory than
  sequential calls. Facts are short (one sentence) and truncation still applies per text, so
  this is bounded in practice.
- **`model.onnx` deletion.** If `dtype` is ever changed away from `fp16`, transformers.js will
  re-download the fp32 file. Acceptable: it is a cache.
