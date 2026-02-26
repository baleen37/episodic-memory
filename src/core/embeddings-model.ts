/**
 * In-process embedding model loading via HuggingFace transformers.
 * Lazy-loaded singleton: first call to initModel() loads the model.
 * Uses dynamic import to avoid loading @huggingface/transformers (and its
 * native dependency `sharp`) at module load time.
 */
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

let embeddingPipeline: FeatureExtractionPipeline | null = null;

export async function initModel(): Promise<void> {
  if (!embeddingPipeline) {
    const { pipeline, env } = await import('@huggingface/transformers');
    console.log('Loading embedding model (first run may take time)...');
    env.cacheDir = './.cache';
    embeddingPipeline = await pipeline(
      'feature-extraction',
      'Supabase/gte-small',
      { dtype: 'fp16' } as any
    );
    console.log('Embedding model loaded');
  }
}

export async function generateEmbeddingFromModel(text: string): Promise<number[] | null> {
  if (!embeddingPipeline) {
    await initModel();
  }
  if (!embeddingPipeline) return null;

  // gte-small: no prefix needed, just truncate
  const truncated = text.substring(0, 8000);

  const output = await embeddingPipeline!(truncated, {
    pooling: 'mean',
    normalize: true,
  });

  return Array.from(output.data);
}
