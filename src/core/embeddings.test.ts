import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { EMBEDDING_DIM } from './constants.js';
import { resetRateLimiters, __setLoadConfigForTests } from './ratelimiter.js';
import { __setModelForTests, isEmbeddingsDisabled, initEmbeddings, embedPassage, embedQuery } from './embeddings.js';

const mockEmbedding = Array.from({ length: EMBEDDING_DIM }, (_, i) => i * 0.001);
let shouldFail = false;
let lastKind: 'passage' | 'query' | null = null;
let lastText: string | null = null;

const mockInit = async () => {
  if (shouldFail) throw new Error('model load failed');
};
const mockGenerate = async (kind: 'passage' | 'query', text: string) => {
  if (shouldFail) throw new Error('generation failed');
  lastKind = kind;
  lastText = text;
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

describe('embedPassage() and embedQuery()', () => {
  beforeEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
    lastKind = null;
    lastText = null;
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

  test('embedPassage returns null when disabled', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    expect(await embedPassage('test')).toBeNull();
  });

  test('embedQuery returns null when disabled', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    expect(await embedQuery('test')).toBeNull();
  });

  test('embedPassage routes with kind="passage"', async () => {
    const result = await embedPassage('hello world');
    expect(result).toEqual(mockEmbedding);
    expect(lastKind).toBe('passage');
    expect(lastText).toBe('hello world');
  });

  test('embedQuery routes with kind="query"', async () => {
    const result = await embedQuery('hello world');
    expect(result).toEqual(mockEmbedding);
    expect(lastKind).toBe('query');
    expect(lastText).toBe('hello world');
  });

  test('returns null on model error', async () => {
    shouldFail = true;
    expect(await embedPassage('hello')).toBeNull();
    expect(await embedQuery('hello')).toBeNull();
  });

  test('handles concurrent passage and query requests', async () => {
    const results = await Promise.all([
      embedPassage('text 1'),
      embedQuery('text 2'),
      embedPassage('text 3'),
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
