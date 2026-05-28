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

const MODEL_ID = 'dragonkue/multilingual-e5-small-ko-v2';

export async function initModel(): Promise<void> {
  if (!embeddingPipeline) {
    const { pipeline, env } = await import('@huggingface/transformers');
    console.log(`Loading embedding model ${MODEL_ID} (first run downloads ~150MB, may take 1-2 min)...`);
    env.cacheDir = './.cache';
    const start = Date.now();
    embeddingPipeline = await pipeline(
      'feature-extraction',
      MODEL_ID,
      { dtype: 'fp16' } as any
    );
    console.log(`Embedding model loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
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
