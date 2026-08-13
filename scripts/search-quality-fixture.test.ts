import { describe, expect, test } from 'bun:test';
import {
  loadSearchQualityFixture,
  validateSearchQualityFixture,
} from './search-quality-fixture.js';
import type { SearchQualityFixture } from './search-quality-fixture.js';

describe('search quality fixture', () => {
  async function mutableFixture(): Promise<SearchQualityFixture> {
    return JSON.parse(JSON.stringify(await loadSearchQualityFixture())) as SearchQualityFixture;
  }

  test('loads the locked sanitized corpus with exact dimensions and cardinalities', async () => {
    const fixture = await loadSearchQualityFixture();
    expect(fixture.corpus).toHaveLength(96);
    expect(fixture.queries).toHaveLength(40);
    expect(fixture.corpus.every((row) => row.embedding.length === 384)).toBe(true);
    expect(fixture.queries.every((query) => query.query.length > 0)).toBe(true);
    expect(fixture.corpus.map((row) => row.id).filter((id) => id.startsWith('memory-'))).toEqual(
      Array.from({ length: 24 }, (_, index) => `memory-${String(index + 1).padStart(3, '0')}`),
    );
    expect(fixture.corpus.map((row) => row.id).filter((id) => id.startsWith('distractor-'))).toEqual(
      Array.from({ length: 72 }, (_, index) => `distractor-${String(index + 1).padStart(3, '0')}`),
    );
    expect(fixture.queries.filter((query) => Object.keys(query.relevance).length === 0)).toHaveLength(5);
  });

  test('every query judgment references a corpus row in the same scope', async () => {
    const fixture = await loadSearchQualityFixture();
    const ids = new Set(fixture.corpus.map((row) => row.id));
    for (const query of fixture.queries) {
      for (const id of Object.keys(query.relevance)) expect(ids.has(id)).toBe(true);
    }
  });

  test('fixture corpus contains exactly five queries for every retrieval case', async () => {
    const fixture = await loadSearchQualityFixture();
    for (const caseName of ['cross-lingual', 'rare-token', 'partial-match', 'distractor', 'scope', 'recency', 'semantic-only', 'lexical-only']) {
      expect(fixture.queries.filter((query) => query.case === caseName)).toHaveLength(5);
    }
  });

  test('rejects malformed rows, judgments, and scopes', async () => {
    const fixture = await mutableFixture();
    const corpus = fixture.corpus;
    const queries = fixture.queries;

    expect(() => validateSearchQualityFixture([...corpus, corpus[0]], queries)).toThrow('duplicate corpus id: memory-001');
    expect(() => validateSearchQualityFixture(corpus.map((row) => row.id === 'memory-001' ? { ...row, embedding: [1] } : row), queries)).toThrow('invalid embedding dimension for corpus row: memory-001');
    expect(() => validateSearchQualityFixture(corpus.map((row) => row.id === 'memory-001' ? { ...row, metadata: {} } : row), queries)).toThrow('missing user_id for corpus row: memory-001');
    expect(() => validateSearchQualityFixture(corpus, [{ ...queries[0], relevance: { 'memory-001': 4 } }])).toThrow('invalid relevance for query:');
    expect(() => validateSearchQualityFixture(corpus, [{ ...queries[0], relevance: { missing: 3 } }])).toThrow('unknown judgment id for query:');
    expect(() => validateSearchQualityFixture(corpus.map((row) => row.id === 'memory-024' ? { ...row, metadata: { ...row.metadata, user_id: '' } } : row), queries)).toThrow('missing user_id for corpus row: memory-024');
    expect(() => validateSearchQualityFixture(corpus.map((row) => row.id === 'memory-024' ? { ...row, metadata: { ...row.metadata, user_id: 'unknown' } } : row), queries)).toThrow('invalid user_id scope for corpus row: memory-024');
    expect(() => validateSearchQualityFixture(corpus, queries.map((query) => query.case === 'distractor' ? { ...query, filters: { user_id: '' } } : query))).toThrow('missing user_id filter for query: no matching synthetic topic benchmark query 1');
    expect(() => validateSearchQualityFixture(corpus, queries.map((query) => query.case === 'distractor' ? { ...query, filters: { user_id: 'unknown' } } : query))).toThrow('invalid user_id scope for query: no matching synthetic topic benchmark query 1');
  });

  test('rejects fixture shrinkage and case substitution', async () => {
    const fixture = await mutableFixture();

    expect(() => validateSearchQualityFixture(fixture.corpus.slice(1), fixture.queries)).toThrow('expected 96 corpus rows');
    expect(() => validateSearchQualityFixture(fixture.corpus.map((row) => row.id === 'memory-024' ? { ...row, id: 'memory-025' } : row), fixture.queries)).toThrow('missing required corpus id: memory-024');
    expect(() => validateSearchQualityFixture(fixture.corpus, fixture.queries.slice(1))).toThrow('expected 40 queries');
    expect(() => validateSearchQualityFixture(fixture.corpus, fixture.queries.map((query, index) => index === 0 ? { ...query, case: 'scope' } : query))).toThrow('expected 5 queries for case: cross-lingual');
    expect(() => validateSearchQualityFixture(fixture.corpus, fixture.queries.map((query) => query.case === 'distractor' && query.query.endsWith('1') ? { ...query, relevance: { 'memory-001': 3 } } : query))).toThrow('expected 5 empty expected-result queries');
  });

  test('uses real synthetic retrieval meanings for cross-lingual and lexical cases', async () => {
    const fixture = await loadSearchQualityFixture();
    const rowsById = new Map(fixture.corpus.map((row) => [row.id, row]));

    for (const query of fixture.queries.filter((candidate) => candidate.case === 'rare-token' || candidate.case === 'lexical-only')) {
      const directId = Object.entries(query.relevance).find(([, relevance]) => relevance === 3)?.[0];
      const rareToken = rowsById.get(directId ?? '')?.memory.match(/ZXQ-[A-Z]+/)?.[0];
      if (!rareToken) throw new Error('expected rare-token relevance target');
      expect(query.query).toContain(rareToken);
    }
    for (const query of fixture.queries.filter((candidate) => candidate.case === 'semantic-only')) {
      const directId = Object.entries(query.relevance).find(([, relevance]) => relevance === 3)?.[0];
      const targetWords = new Set(rowsById.get(directId ?? '')?.memory.toLowerCase().match(/[a-z]+/g));
      expect(query.query.toLowerCase().match(/[a-z]+/g)?.some((word) => targetWords.has(word))).toBe(false);
    }
    for (const query of fixture.queries.filter((candidate) => candidate.case === 'cross-lingual')) {
      const directId = Object.entries(query.relevance).find(([, relevance]) => relevance === 3)?.[0];
      expect(query.query).toMatch(/[가-힣]|[¿¡]/);
      expect(rowsById.get(directId ?? '')?.memory).toMatch(/^[\x00-\x7F]+$/);
    }
  });
});
