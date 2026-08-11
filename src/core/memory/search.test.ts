import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createMemorySchema } from './schema.js';
import { insertMemories } from './store.js';
import { searchMemories } from './search.js';
import { __setModelForTests } from '../embeddings.js';

// Deterministic 384-dim embeddings: direction encoded in the first slot.
function vec(seed: number): number[] {
  const v = new Array(384).fill(0);
  v[0] = Math.cos(seed);
  v[1] = Math.sin(seed);
  return v;
}

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  sqliteVec.load(db);
  createMemorySchema(db);
  __setModelForTests(async () => {}, async (_kind, text) => {
    if (text.includes('puppy')) return vec(0);
    if (text.includes('pottery')) return vec(1.5);
    return vec(3.0);
  });
});
afterEach(() => { __setModelForTests(null, null); });

function seed() {
  insertMemories(db, [
    { id: 'm1', memory: 'User adopted a beagle puppy named Max', metadata: { user_id: 'alice' }, embedding: vec(0) },
    { id: 'm2', memory: 'User started pottery classes on Tuesdays', metadata: { user_id: 'alice' }, embedding: vec(1.5) },
    { id: 'm3', memory: 'Unrelated fact about servers', metadata: { user_id: 'bob' }, embedding: vec(3.0) },
  ]);
}

describe('searchMemories', () => {
  test('requires a scoping filter', async () => {
    await expect(searchMemories({ db, query: 'puppy', filters: {} })).rejects.toThrow(/user_id/);
  });

  test('rejects an out-of-range threshold', async () => {
    await expect(searchMemories({ db, query: 'x', filters: { user_id: 'alice' }, threshold: 1.5 }))
      .rejects.toThrow(/threshold/i);
  });

  test('ranks the semantically closest memory first', async () => {
    seed();
    const { results } = await searchMemories({ db, query: 'puppy', filters: { user_id: 'alice' } });
    expect(results[0].id).toBe('m1');
  });

  test('applies metadata filters', async () => {
    seed();
    const { results } = await searchMemories({ db, query: 'puppy', filters: { user_id: 'bob' } });
    expect(results.every(r => r.metadata.user_id === 'bob')).toBe(true);
  });

  test('returns scores in [0,1]', async () => {
    seed();
    const { results } = await searchMemories({ db, query: 'puppy', filters: { user_id: 'alice' } });
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  test('BM25 lifts an exact keyword match above a weaker semantic one', async () => {
    // BM25 IDF collapses on tiny corpora, so pad the store until keyword scores are non-zero.
    seed();
    const filler = Array.from({ length: 200 }, (_, i) => ({
      id: `f${i}`,
      memory: `Filler record ${i} about servers and deployments`,
      metadata: { user_id: 'alice' },
      embedding: vec(3.0),
    }));
    insertMemories(db, filler);

    const { results } = await searchMemories({
      db, query: 'pottery', filters: { user_id: 'alice' }, explain: true,
    });
    expect(results[0].id).toBe('m2');
    expect(results[0].score_details!.bm25_score).toBeGreaterThan(0);
  });

  test('degrades to semantic-only when no keyword matches', async () => {
    // A query term absent from every document yields no BM25 rows at all, so
    // the divisor stays 1.0. (Note: a *small* corpus does NOT zero out BM25 —
    // IDF collapses only when the term appears in nearly every document.)
    // The fake embedder maps any unrecognized text to vec(3.0), which is m3's
    // exact direction — so scope to bob (who owns m3) for a surviving candidate.
    seed();
    const { results } = await searchMemories({
      db, query: 'zzzznomatch', filters: { user_id: 'bob' }, explain: true,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score_details!.bm25_score).toBe(0);
    expect(results[0].score_details!.max_possible_score).toBe(1.0);
  });

  test('explain exposes the score breakdown', async () => {
    seed();
    const { results } = await searchMemories({
      db, query: 'puppy', filters: { user_id: 'alice' }, explain: true,
    });
    expect(results[0].score_details).toBeDefined();
    expect(results[0].score_details!.max_possible_score).toBeGreaterThanOrEqual(1.0);
  });

  test('omits score_details by default', async () => {
    seed();
    const { results } = await searchMemories({ db, query: 'puppy', filters: { user_id: 'alice' } });
    expect(results[0].score_details).toBeUndefined();
  });

  test('honors limit', async () => {
    seed();
    const { results } = await searchMemories({ db, query: 'puppy', filters: { user_id: 'alice' }, limit: 1 });
    expect(results).toHaveLength(1);
  });

  test('threshold drops candidates whose raw semantic score is below it', async () => {
    // 'puppy' embeds to vec(0); m2/m3 sit at vec(1.5)/vec(3.0), so their
    // semantic scores fall below 0.9 while m1 (an exact vector match) clears it.
    seed();
    const { results } = await searchMemories({
      db, query: 'puppy', filters: { user_id: 'alice' }, threshold: 0.9,
    });
    expect(results.map(r => r.id)).toEqual(['m1']);
  });

  test('a threshold above every semantic score returns nothing', async () => {
    // No document is close to this query direction, so every raw semantic
    // score falls under the gate and nothing survives.
    seed();
    const { results } = await searchMemories({
      db, query: 'pottery', filters: { user_id: 'bob' }, threshold: 0.9,
    });
    expect(results).toHaveLength(0);
  });

  test('returns an empty list on an empty store', async () => {
    const { results } = await searchMemories({ db, query: 'anything', filters: { user_id: 'alice' } });
    expect(results).toEqual([]);
  });

  test('promotes scoping keys onto the result', async () => {
    seed();
    const { results } = await searchMemories({ db, query: 'puppy', filters: { user_id: 'alice' } });
    expect(results[0]).toHaveProperty('memory');
    expect(results[0]).toHaveProperty('created_at');
  });
});
