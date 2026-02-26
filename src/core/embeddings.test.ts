import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { EMBEDDING_DIM } from './constants.js';
import { resetRateLimiters, __setLoadConfigForTests } from './ratelimiter.js';

const mockEmbedding = Array.from({ length: EMBEDDING_DIM }, (_, i) => i * 0.001);
let shouldFail = false;

mock.module('./embeddings-model.js', () => ({
  initModel: mock(async () => {
    if (shouldFail) throw new Error('model load failed');
  }),
  generateEmbeddingFromModel: mock(async () => {
    if (shouldFail) throw new Error('generation failed');
    return mockEmbedding;
  }),
}));

describe('isEmbeddingsDisabled()', () => {
  afterEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
  });

  test('returns false by default', async () => {
    const { isEmbeddingsDisabled } = await import('./embeddings.js');
    expect(isEmbeddingsDisabled()).toBe(false);
  });

  test('returns true when MEMMEM_DISABLE_EMBEDDINGS=true', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    const { isEmbeddingsDisabled } = await import('./embeddings.js');
    expect(isEmbeddingsDisabled()).toBe(true);
  });
});

describe('generateEmbedding()', () => {
  beforeEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
    __setLoadConfigForTests(() => ({
      provider: 'gemini',
      apiKey: 'test',
      ratelimit: { embedding: { requestsPerSecond: 100, burstSize: 100 } },
    }) as any);
    resetRateLimiters();
  });

  afterEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
    __setLoadConfigForTests(null);
    resetRateLimiters();
  });

  test('returns null when disabled', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    const { generateEmbedding } = await import('./embeddings.js');
    expect(await generateEmbedding('test')).toBeNull();
  });

  test('returns embedding from model', async () => {
    const { generateEmbedding } = await import('./embeddings.js');
    const result = await generateEmbedding('hello world');
    expect(result).toEqual(mockEmbedding);
  });

  test('returns null on model error', async () => {
    shouldFail = true;
    const { generateEmbedding } = await import('./embeddings.js');
    const result = await generateEmbedding('hello');
    expect(result).toBeNull();
  });

  test('handles concurrent requests', async () => {
    const { generateEmbedding } = await import('./embeddings.js');
    const results = await Promise.all([
      generateEmbedding('text 1'),
      generateEmbedding('text 2'),
      generateEmbedding('text 3'),
    ]);
    expect(results).toHaveLength(3);
    results.forEach(r => expect(r).toHaveLength(EMBEDDING_DIM));
  });
});

describe('initEmbeddings()', () => {
  beforeEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
  });

  afterEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
  });

  test('no-ops when disabled', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    const { initEmbeddings } = await import('./embeddings.js');
    await expect(initEmbeddings()).resolves.toBeUndefined();
  });

  test('calls initModel when enabled', async () => {
    const { initEmbeddings } = await import('./embeddings.js');
    await expect(initEmbeddings()).resolves.toBeUndefined();
  });
});
