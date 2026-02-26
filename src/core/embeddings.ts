/**
 * In-process embedding generation via HuggingFace transformers.
 * Model is lazy-loaded on first use and stays in memory.
 */
import { initModel as defaultInitModel, generateEmbeddingFromModel as defaultGenerate } from './embeddings-model.js';
import { getEmbeddingRateLimiter } from './ratelimiter.js';

let initModelFn = defaultInitModel;
let generateFn = defaultGenerate;

/** Override model functions for testing. Pass null to reset. */
export function __setModelForTests(
  init: (() => Promise<void>) | null,
  generate: ((text: string) => Promise<number[]>) | null,
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

export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (isEmbeddingsDisabled()) return null;
  try {
    await getEmbeddingRateLimiter().acquire();
    return await generateFn(text);
  } catch {
    return null;
  }
}
