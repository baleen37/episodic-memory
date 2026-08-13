import { describe, expect, test } from 'bun:test';
import {
  loadSearchQualityFixture,
  validateSearchQualityFixture,
} from './search-quality-fixture.js';

describe('search quality fixture', () => {
  test('loads a non-empty sanitized corpus with valid 384-dimensional vectors', async () => {
    const fixture = await loadSearchQualityFixture();
    expect(fixture.corpus.length).toBeGreaterThanOrEqual(20);
    expect(fixture.queries.length).toBeGreaterThanOrEqual(40);
    expect(fixture.corpus.every((row) => row.embedding.length === 384)).toBe(true);
    expect(fixture.queries.every((query) => query.query.length > 0)).toBe(true);
  });

  test('every query judgment references a corpus row in the same scope', async () => {
    const fixture = await loadSearchQualityFixture();
    const ids = new Set(fixture.corpus.map((row) => row.id));
    for (const query of fixture.queries) {
      for (const id of Object.keys(query.relevance)) expect(ids.has(id)).toBe(true);
    }
  });

  test('fixture corpus contains all required retrieval cases', async () => {
    const fixture = await loadSearchQualityFixture();
    expect(fixture.queries.filter((query) => query.case === 'cross-lingual').length).toBeGreaterThanOrEqual(5);
    expect(fixture.queries.filter((query) => query.case === 'rare-token').length).toBeGreaterThanOrEqual(5);
    expect(fixture.queries.filter((query) => query.case === 'partial-match').length).toBeGreaterThanOrEqual(5);
    expect(fixture.queries.filter((query) => query.case === 'distractor').length).toBeGreaterThanOrEqual(5);
    expect(fixture.queries.filter((query) => query.case === 'scope').length).toBeGreaterThanOrEqual(5);
    expect(fixture.queries.filter((query) => query.case === 'recency').length).toBeGreaterThanOrEqual(5);
    expect(fixture.queries.filter((query) => query.case === 'semantic-only').length).toBeGreaterThanOrEqual(5);
    expect(fixture.queries.filter((query) => query.case === 'lexical-only').length).toBeGreaterThanOrEqual(5);
  });

  test('rejects malformed rows and judgments', () => {
    const validEmbedding = [1, ...Array.from({ length: 383 }, () => 0)];
    const corpus = [{
      id: 'memory-001',
      memory: 'Synthetic benchmark row.',
      metadata: { user_id: 'local' },
      embedding: validEmbedding,
    }];
    const queries = [{
      query: 'synthetic benchmark',
      case: 'semantic-only',
      filters: { user_id: 'local' },
      queryEmbedding: validEmbedding,
      relevance: { 'memory-001': 3 },
    }];

    expect(() => validateSearchQualityFixture([...corpus, corpus[0]], queries)).toThrow('duplicate corpus id: memory-001');
    expect(() => validateSearchQualityFixture([{ ...corpus[0], embedding: [1] }], queries)).toThrow('invalid embedding dimension for corpus row: memory-001');
    expect(() => validateSearchQualityFixture([{ ...corpus[0], metadata: {} }], queries)).toThrow('missing user_id for corpus row: memory-001');
    expect(() => validateSearchQualityFixture(corpus, [{ ...queries[0], relevance: { 'memory-001': 4 } }])).toThrow('invalid relevance for query: synthetic benchmark');
    expect(() => validateSearchQualityFixture(corpus, [{ ...queries[0], relevance: { missing: 3 } }])).toThrow('unknown judgment id for query: synthetic benchmark');
  });
});
