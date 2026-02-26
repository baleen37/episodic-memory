/**
 * In-process embedding generation via HuggingFace transformers.
 * Model is lazy-loaded on first use and stays in memory.
 */
import { getEmbeddingRateLimiter } from './ratelimiter.js';

export function isEmbeddingsDisabled(): boolean {
  return process.env.MEMMEM_DISABLE_EMBEDDINGS === 'true';
}

export async function initEmbeddings(): Promise<void> {
  if (isEmbeddingsDisabled()) return;
  const { initModel } = await import('./embeddings-model.js');
  await initModel();
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (isEmbeddingsDisabled()) return null;
  try {
    await getEmbeddingRateLimiter().acquire();
    const { generateEmbeddingFromModel } = await import('./embeddings-model.js');
    return await generateEmbeddingFromModel(text);
  } catch {
    return null;
  }
}
