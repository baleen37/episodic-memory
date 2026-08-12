/**
 * In-process embedding model loading via HuggingFace transformers.
 * Lazy-loaded singleton: first call to initModel() loads the model.
 * Uses dynamic import to avoid loading @huggingface/transformers (and its
 * native dependency `sharp`) at module load time.
 */
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { log } from './logger.js';
import { EMBEDDING_DIM } from './constants.js';
import { getModelCacheDir } from './paths.js';

let embeddingPipeline: FeatureExtractionPipeline | null = null;
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;

const PREFIX = {
  passage: 'passage: ',
  query: 'query: ',
} as const;

const MAX_CONTENT_CHARS = 8000;

const MODEL_ID = 'Xenova/multilingual-e5-small';

async function loadPipeline(): Promise<FeatureExtractionPipeline> {
  const { pipeline, env } = await import('@huggingface/transformers');
  log.info(`Loading embedding model ${MODEL_ID} (first run downloads ~150MB, may take 1-2 min)...`);
  env.cacheDir = getModelCacheDir();
  const start = Date.now();
  const result = await pipeline(
    'feature-extraction',
    MODEL_ID,
    { dtype: 'fp16' } as any
  );
  const ms = Date.now() - start;
  log.info(`Embedding model loaded in ${(ms / 1000).toFixed(1)}s`, { dim: EMBEDDING_DIM, ms });
  return result;
}

export async function initModel(): Promise<void> {
  if (embeddingPipeline) return;
  if (!loadingPromise) {
    loadingPromise = loadPipeline();
  }
  embeddingPipeline = await loadingPromise;
}

/**
 * Splits a batched feature-extraction tensor into one vector per input.
 *
 * transformers.js returns `dims = [rows, EMBEDDING_DIM]` with contiguous rows
 * in input order, so the flat buffer slices evenly.
 */
export function sliceBatchOutput(data: ArrayLike<number>, rows: number): number[][] {
  if (rows === 0) return [];
  const expected = rows * EMBEDDING_DIM;
  if (data.length !== expected) {
    throw new Error(
      `batch embedding size mismatch: expected ${rows} texts worth of floats (${expected}), got ${data.length}`,
    );
  }
  const out: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const start = r * EMBEDDING_DIM;
    out.push(Array.from(Array.prototype.slice.call(data, start, start + EMBEDDING_DIM)));
  }
  return out;
}

/** Embed several texts in a single forward pass. */
export async function generateEmbeddingsFromModel(
  kind: 'passage' | 'query',
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!embeddingPipeline) {
    await initModel();
  }
  if (!embeddingPipeline) return [];

  const inputs = texts.map(t => PREFIX[kind] + t.substring(0, MAX_CONTENT_CHARS));

  const output = await embeddingPipeline!(inputs, {
    pooling: 'mean',
    normalize: true,
  });

  return sliceBatchOutput(output.data, texts.length);
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
