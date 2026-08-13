import { describe, expect, test } from 'bun:test';
import { ENTITY_BOOST_WEIGHT, buildFtsMatchQuery, getBm25Params, normalizeBm25, lemmatizeForBm25, scoreAndRank } from './scoring.js';

describe('getBm25Params', () => {
  test('buckets by lemmatized term count', () => {
    expect(getBm25Params('a b c')).toEqual([5.0, 0.7]);
    expect(getBm25Params('a b c d')).toEqual([7.0, 0.6]);
    expect(getBm25Params('a b c d e f g')).toEqual([9.0, 0.5]);
    expect(getBm25Params('a b c d e f g h i j')).toEqual([10.0, 0.5]);
    expect(getBm25Params(Array(16).fill('x').join(' '))).toEqual([12.0, 0.5]);
  });
  test('empty query counts as one term', () => {
    expect(getBm25Params('')).toEqual([5.0, 0.7]);
  });
});

describe('normalizeBm25', () => {
  test('midpoint maps to 0.5', () => {
    expect(normalizeBm25(5.0, 5.0, 0.7)).toBeCloseTo(0.5, 10);
  });
  test('is monotonic increasing and bounded in [0,1]', () => {
    const low = normalizeBm25(0, 5.0, 0.7);
    const high = normalizeBm25(20, 5.0, 0.7);
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThan(1);
  });
});

describe('lemmatizeForBm25', () => {
  test('lowercases and collapses whitespace', () => {
    expect(lemmatizeForBm25('  Search   QUALITY ')).toBe('search quality');
  });
});

describe('buildFtsMatchQuery', () => {
  test('OR-combines terms so partial matches still score', () => {
    expect(buildFtsMatchQuery('embedding batch sync')).toBe('"embedding" OR "batch" OR "sync"');
  });

  test('quotes a single term', () => {
    expect(buildFtsMatchQuery('embedding')).toBe('"embedding"');
  });

  test('returns empty for an empty query', () => {
    expect(buildFtsMatchQuery('')).toBe('');
  });

  test('treats FTS5 operators as literals', () => {
    expect(buildFtsMatchQuery('cats and dogs')).toBe('"cats" OR "and" OR "dogs"');
  });

  test('escapes embedded quotes', () => {
    expect(buildFtsMatchQuery('say "hi"')).toBe('"say" OR """hi"""');
  });
});

describe('scoreAndRank', () => {
  const cand = (id: string, score: number): Candidate => ({ id, score, payload: { data: id } });
  type Candidate = { id: string; score: number; payload: Record<string, unknown> | null };

  test('semantic only uses divisor 1.0', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.8)], bm25Scores: {}, entityBoosts: {},
      threshold: 0.1, topK: 10,
    });
    expect(out[0].score).toBeCloseTo(0.8, 10);
  });

  test('semantic + bm25 uses divisor 2.0', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.8)], bm25Scores: { a: 0.6 }, entityBoosts: {},
      threshold: 0.1, topK: 10,
    });
    expect(out[0].score).toBeCloseTo(0.7, 10); // (0.8+0.6)/2.0
  });

  test('semantic + entity uses divisor 1.5', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.9)], bm25Scores: {}, entityBoosts: { a: 0.5 },
      threshold: 0.1, topK: 10,
    });
    expect(out[0].score).toBeCloseTo(1.4 / 1.5, 10);
  });

  test('all three signals use divisor 2.5', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.8)], bm25Scores: { a: 0.6 }, entityBoosts: { a: 0.5 },
      threshold: 0.1, topK: 10,
    });
    expect(out[0].score).toBeCloseTo(1.9 / 2.5, 10);
  });

  test('divisor depends on signal presence globally, not per-candidate', () => {
    // 'b' has no bm25 entry but divisor is still 2.0 because bm25Scores is non-empty
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.8), cand('b', 0.8)], bm25Scores: { a: 0.6 }, entityBoosts: {},
      threshold: 0.1, topK: 10,
    });
    const b = out.find(r => r.id === 'b')!;
    expect(b.score).toBeCloseTo(0.4, 10); // 0.8/2.0
  });

  test('threshold gates raw semantic BEFORE combining', () => {
    // semantic 0.05 < threshold even though bm25 1.0 would rescue it
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.05)], bm25Scores: { a: 1.0 }, entityBoosts: {},
      threshold: 0.1, topK: 10,
    });
    expect(out).toHaveLength(0);
  });

  test('combined score clamps at 1.0', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 1.0)], bm25Scores: { a: 1.0 }, entityBoosts: { a: 0.9 },
      threshold: 0.1, topK: 10,
    });
    expect(out[0].score).toBe(1.0);
  });

  test('sorts descending and truncates to topK', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.3), cand('b', 0.9), cand('c', 0.6)],
      bm25Scores: {}, entityBoosts: {}, threshold: 0.1, topK: 2,
    });
    expect(out.map(r => r.id)).toEqual(['b', 'c']);
  });

  test('explain exposes score_details', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.8)], bm25Scores: { a: 0.6 }, entityBoosts: {},
      threshold: 0.1, topK: 10, explain: true,
    });
    expect(out[0].score_details).toEqual({
      semantic_score: 0.8, bm25_score: 0.6, entity_boost: 0,
      raw_score: 1.4, max_possible_score: 2.0,
      final_score: 0.7, threshold: 0.1,
    });
  });

  test('omits score_details when explain is false', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.8)], bm25Scores: {}, entityBoosts: {}, threshold: 0.1, topK: 10,
    });
    expect(out[0].score_details).toBeUndefined();
  });

  test('ENTITY_BOOST_WEIGHT matches mem0', () => {
    expect(ENTITY_BOOST_WEIGHT).toBe(0.5);
  });
});
