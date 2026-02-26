# IPC Socket Removal: In-Process Embedding

## Problem

The embedding system uses a complex IPC architecture:
- `embeddings.ts` (151 lines): Unix domain socket client with retry logic, spawn management, shared socket, pending request map
- `embedding-worker.ts` (113 lines): Standalone server process with idle timeout, connection tracking, socket lifecycle
- Separate build entrypoint in `build.mjs`
- Test infrastructure: mock sockets, `__setWorkerConnectorForTests`, real socket integration tests

Total: ~264 lines + test complexity for what is essentially `generateEmbeddingFromModel(text)`.

## Design

Replace IPC client/server with direct in-process calls to `embeddings-model.ts`.

### What changes

| File | Action |
|------|--------|
| `src/core/embeddings.ts` | Rewrite: remove IPC, call `embeddings-model.ts` directly |
| `src/mcp/embedding-worker.ts` | Delete |
| `src/mcp/embedding-worker.test.ts` | Delete |
| `src/core/embeddings.test.ts` | Rewrite: test in-process behavior instead of mock sockets |
| `scripts/build.mjs` | Remove `embedding-worker.ts` entrypoint |
| `src/core/embeddings-model.ts` | Remove "worker-only" comment, keep as-is |

### New `embeddings.ts` (~30 lines)

```typescript
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

### Callers (no changes needed)

- `db.ts:createObservation()` — calls `initEmbeddings()` then `generateEmbedding()`. Works as-is.
- `search.ts:vector_search()` — calls `initEmbeddings()` then `generateEmbedding()`. Works as-is.

### Model loading behavior by context

| Context | When model loads | Acceptable? |
|---------|-----------------|-------------|
| Stop hook (extract CLI) | First `createObservation()` call, then reused for batch | Yes — one load, many observations |
| MCP server (search) | First `search()` call, stays in memory | Yes — long-running process |
| PostToolUse (record CLI) | Never — no embedding in this path | N/A |
| SessionStart (recall CLI) | Never — reads DB only, no embedding | N/A |

### Rate limiter

Embedding rate limiter stays. `acquire()` moves from worker to `embeddings.ts`.

### What gets deleted

- Socket path management (`getSocketPath`, `getSuperpowersDir` usage for sockets)
- Worker spawn logic (`spawnWorker`, `getWorkerBinaryPath`, `MEMMEM_WORKER_BINARY` env var)
- IPC protocol (newline-delimited JSON, request ID matching, pending map)
- Connection management (retry with exponential backoff, shared socket, reconnection)
- Worker lifecycle (idle timeout, active connection tracking, duplicate detection)
- Test injection hook (`__setWorkerConnectorForTests`)
- `dist/embedding-worker.mjs` build output

### Risk

Low. The only behavioral change is that `@huggingface/transformers` + ONNX runtime load into the calling process instead of a separate worker. This affects memory usage of the Stop hook CLI and MCP server processes, but both are short-lived or long-running respectively, so this is acceptable.

## Verification

1. `bun test` — all tests pass
2. `bun run build` — builds without embedding-worker entrypoint
3. `bun run typecheck` — no type errors
4. Manual: run Stop hook, verify observations get embeddings
5. Manual: MCP search returns vector results
