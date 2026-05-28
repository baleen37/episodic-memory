/**
 * In-process embedding generation via HuggingFace transformers.
 * Model is lazy-loaded on first use and stays in memory.
 */
import { initModel as defaultInitModel, generateEmbeddingFromModel as defaultGenerate } from './embeddings-model.js';
import { log } from './logger.js';
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
  } catch (err) {
    log.warn(`embedding failed (${kind})`, { error: (err as Error).message });
    return null;
  }
}
