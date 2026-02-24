/**
 * Direct in-process embedding model loading via HuggingFace transformers.
 * Used only by the embedding worker process. Do NOT import this from other modules.
 */
import { pipeline, FeatureExtractionPipeline, env } from '@huggingface/transformers';

let embeddingPipeline: FeatureExtractionPipeline | null = null;

export async function initModel(): Promise<void> {
  if (!embeddingPipeline) {
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
