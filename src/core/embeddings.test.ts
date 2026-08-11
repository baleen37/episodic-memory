import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { EMBEDDING_DIM } from './constants.js';
import {
  __setModelForTests,
  __setBatchModelForTests,
  __setEmbeddingConfigForTests,
  __resetEmbeddingConcurrencyForTests,
  isEmbeddingsDisabled,
  initEmbeddings,
  embedPassage,
  embedQuery,
  embedPassageBatch,
  EmbeddingError,
} from './embeddings.js';

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
  });

  afterEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    shouldFail = false;
    __setModelForTests(null, null);
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

  test('embedPassage throws EmbeddingError on model failure', async () => {
    shouldFail = true;
    await expect(embedPassage('hello')).rejects.toThrow(EmbeddingError);
  });

  test('embedQuery throws EmbeddingError on model failure', async () => {
    shouldFail = true;
    await expect(embedQuery('hello')).rejects.toThrow(EmbeddingError);
  });

  test('EmbeddingError message names the failing kind', async () => {
    shouldFail = true;
    await expect(embedPassage('hello')).rejects.toThrow(/passage/);
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

describe('embedPassageBatch()', () => {
  let calls: number;
  let peak: number;
  let active: number;

  beforeEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    calls = 0;
    peak = 0;
    active = 0;
    __setEmbeddingConfigForTests(() => ({
      provider: 'gemini',
      apiKey: 'test',
      embedding: { maxConcurrency: 2 },
    }) as any);
    __resetEmbeddingConcurrencyForTests();
    __setBatchModelForTests(async (_kind, texts) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
      return texts.map(() => mockEmbedding);
    });
  });

  afterEach(() => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    __setBatchModelForTests(null);
    __setEmbeddingConfigForTests(null);
    __resetEmbeddingConcurrencyForTests();
  });

  test('embeds N texts with one model call', async () => {
    const result = await embedPassageBatch(['a', 'b', 'c']);
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(EMBEDDING_DIM);
    expect(calls).toBe(1);
  });

  test('returns an empty array for no texts without calling the model', async () => {
    expect(await embedPassageBatch([])).toEqual([]);
    expect(calls).toBe(0);
  });

  test('caps concurrent batches at maxConcurrency', async () => {
    await Promise.all(Array.from({ length: 6 }, () => embedPassageBatch(['x'])));
    expect(peak).toBe(2);
  });

  test('throws EmbeddingError when the model returns the wrong count', async () => {
    __setBatchModelForTests(async () => [mockEmbedding]);
    await expect(embedPassageBatch(['a', 'b'])).rejects.toThrow(EmbeddingError);
  });

  test('returns empty when embeddings are disabled', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    expect(await embedPassageBatch(['a'])).toEqual([]);
    expect(calls).toBe(0);
  });
});
