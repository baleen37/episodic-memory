import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { EMBEDDING_DIM } from './constants.js';
import { resetRateLimiters, __setLoadConfigForTests } from './ratelimiter.js';
import { __setModelForTests, isEmbeddingsDisabled, initEmbeddings, generateEmbedding } from './embeddings.js';

const mockEmbedding = Array.from({ length: EMBEDDING_DIM }, (_, i) => i * 0.001);
let shouldFail = false;

const mockInit = async () => {
  if (shouldFail) throw new Error('model load failed');
};
const mockGenerate = async () => {
  if (shouldFail) throw new Error('generation failed');
  return mockEmbedding;
};

describe('isEmbeddingsDisabled()', () => {
  afterEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
  });

  test('returns false by default', () => {
    expect(isEmbeddingsDisabled()).toBe(false);
  });

  test('returns true when MEMMEM_DISABLE_EMBEDDINGS=true', () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    expect(isEmbeddingsDisabled()).toBe(true);
  });
});

describe('generateEmbedding()', () => {
  beforeEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
    __setModelForTests(mockInit, mockGenerate);
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
    __setModelForTests(null, null);
    __setLoadConfigForTests(null);
    resetRateLimiters();
  });

  test('returns null when disabled', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    expect(await generateEmbedding('test')).toBeNull();
  });

  test('returns embedding from model', async () => {
    const result = await generateEmbedding('hello world');
    expect(result).toEqual(mockEmbedding);
  });

  test('returns null on model error', async () => {
    shouldFail = true;
    const result = await generateEmbedding('hello');
    expect(result).toBeNull();
  });

  test('handles concurrent requests', async () => {
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
    __setModelForTests(mockInit, mockGenerate);
  });

  afterEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
    __setModelForTests(null, null);
  });

  test('no-ops when disabled', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    await expect(initEmbeddings()).resolves.toBeUndefined();
  });

  test('calls initModel when enabled', async () => {
    await expect(initEmbeddings()).resolves.toBeUndefined();
  });
});
