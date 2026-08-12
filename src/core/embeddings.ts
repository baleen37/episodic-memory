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
import { getEmbeddingRateLimiter } from './ratelimiter.js';

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

type LoadConfigFn = typeof loadConfig;
let loadConfigFn: LoadConfigFn = loadConfig;

/** Override config loading for testing. Pass null to reset. */
export function __setEmbeddingConfigForTests(fn: LoadConfigFn | null): void {
  loadConfigFn = fn ?? loadConfig;
  semaphore = null; // force the cap to be re-read on next use
}

let semaphore: Semaphore | null = null;

function getSemaphore(): Semaphore {
  if (!semaphore) {
    // config.json is untrusted input: a non-numeric maxConcurrency must fall
    // back to the default rather than silently degrading to serial embedding.
    const configured = loadConfigFn()?.embedding?.maxConcurrency;
    const cap = typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
      ? configured
      : DEFAULT_EMBEDDING_MAX_CONCURRENCY;
    semaphore = new Semaphore(cap);
  }
  return semaphore;
}

/**
 * True when the user explicitly configured `ratelimit.embedding`.
 *
 * The rps limiter is the wrong instrument for an in-process CPU model, so it is
 * no longer applied by default. But someone who deliberately set a limit — to
 * keep a shared machine responsive, say — should not silently lose it.
 */
function hasExplicitEmbeddingRateLimit(): boolean {
  return loadConfigFn()?.ratelimit?.embedding !== undefined;
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
    if (hasExplicitEmbeddingRateLimit()) await getEmbeddingRateLimiter().acquire();
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
    if (hasExplicitEmbeddingRateLimit()) await getEmbeddingRateLimiter().acquire();
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
