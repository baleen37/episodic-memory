import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createMemorySchema } from './schema.js';
import { insertMemories } from './store.js';
import { searchMemories, searchMemoriesMulti } from './search.js';
import { __setModelForTests } from '../embeddings.js';
import { resetRateLimiters, __setLoadConfigForTests } from '../ratelimiter.js';

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
  __setLoadConfigForTests(() => ({
    ratelimit: { embedding: { requestsPerSecond: 100, burstSize: 100 } },
  }) as any);
  resetRateLimiters();
});
afterEach(() => {
  __setModelForTests(null, null);
  __setLoadConfigForTests(null);
  resetRateLimiters();
});

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

  test('returns empty results when embedding fails', async () => {
    __setModelForTests(async () => {}, async () => { throw new Error('model down'); });
    const { results } = await searchMemories({
      db,
      query: 'anything',
      filters: { user_id: 'local' },
    });
    expect(results).toEqual([]);
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
      db, query: 'pottery', filters: { user_id: 'alice' },
    });
    expect(results[0].id).toBe('m2');
  });

  test('BM25 still scores when only some query terms match', async () => {
    // FTS5 joins bare space-separated terms with an implicit AND, so a
    // multi-word query used to match nothing unless one document contained
    // every term. Terms are OR-combined so partial matches still score.
    seed();
    const filler = Array.from({ length: 200 }, (_, i) => ({
      id: `f${i}`,
      memory: `Filler record ${i} about servers and deployments`,
      metadata: { user_id: 'alice' },
      embedding: vec(3.0),
    }));
    insertMemories(db, filler);

    const { results } = await searchMemories({
      db, query: 'pottery zzzznomatch', filters: { user_id: 'alice' },
    });
    expect(results[0].id).toBe('m2');
  });

  test('degrades to semantic-only when no keyword matches', async () => {
    // A query term absent from every document yields no BM25 rows at all, so
    // the divisor stays 1.0. (Note: a *small* corpus does NOT zero out BM25 —
    // IDF collapses only when the term appears in nearly every document.)
    // The fake embedder maps any unrecognized text to vec(3.0), which is m3's
    // exact direction — so scope to bob (who owns m3) for a surviving candidate.
    seed();
    const { results } = await searchMemories({
      db, query: 'zzzznomatch', filters: { user_id: 'bob' },
    });
    expect(results.length).toBeGreaterThan(0);
  });

  test('does not expose score details', async () => {
    seed();
    const { results } = await searchMemories({ db, query: 'puppy', filters: { user_id: 'alice' } });
    expect(results[0].score_details).toBeUndefined();
  });

  test('honors limit', async () => {
    seed();
    const { results } = await searchMemories({ db, query: 'puppy', filters: { user_id: 'alice' }, limit: 1 });
    expect(results).toHaveLength(1);
  });

  test('uses a default limit of 10', async () => {
    seed();
    insertMemories(db, Array.from({ length: 12 }, (_, i) => ({
      id: `limit-${i}`,
      memory: `Limit filler ${i}`,
      metadata: { user_id: 'alice' },
      embedding: vec(0),
    })));
    const { results } = await searchMemories({
      db, query: 'puppy', filters: { user_id: 'alice' },
    });
    expect(results).toHaveLength(10);
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

  test('widens the KNN k so a selective filter does not starve results below the requested limit', async () => {
    // internalLimit = max(limit*4, 60) = 60, so the initial k is 60. Seed 2000 rows
    // semantically CLOSER to the query than a 40-row selective slice that matches
    // the agent_id filter — a fixed initial k=60 would fill entirely with the closer,
    // non-matching filler and clip the matching rows before the filter ever runs.
    const filler = Array.from({ length: 2000 }, (_, i) => ({
      id: `bulk-${i}`,
      memory: `Bulk record ${i} about servers and deployments`,
      metadata: { user_id: 'local', agent_id: 'claude-code-projects' },
      embedding: vec(3.0 + i * 0.00001),
    }));
    const selective = Array.from({ length: 40 }, (_, i) => ({
      id: `sel-${i}`,
      memory: `Selective codex record ${i} about servers and deployments`,
      metadata: { user_id: 'local', agent_id: 'codex-sessions' },
      embedding: vec(3.0 + 0.02 + i * 0.00001),
    }));
    insertMemories(db, [...filler, ...selective]);

    const { results } = await searchMemories({
      db,
      query: 'servers and deployments',
      filters: { user_id: 'local', agent_id: 'codex-sessions' },
      limit: 20,
    });

    expect(results).toHaveLength(20);
    expect(results.every(r => r.metadata.agent_id === 'codex-sessions')).toBe(true);
  });

  test('multi-query search returns only records matching every query with mean scores', async () => {
    seed();
    insertMemories(db, [
      {
        id: 'm4',
        memory: 'User combined puppy care with pottery classes',
        metadata: { user_id: 'alice' },
        embedding: vec(0.75),
      },
    ]);

    const [puppy, pottery] = await Promise.all([
      searchMemories({ db, query: 'puppy', filters: { user_id: 'alice' }, limit: 60 }),
      searchMemories({ db, query: 'pottery', filters: { user_id: 'alice' }, limit: 60 }),
    ]);
    const expected = (
      puppy.results.find(result => result.id === 'm4')!.score
      + pottery.results.find(result => result.id === 'm4')!.score
    ) / 2;

    const { results } = await searchMemoriesMulti({
      db,
      queries: ['puppy', 'pottery'],
      filters: { user_id: 'alice' },
      limit: 10,
    });

    expect(results.map(result => result.id)).toEqual(['m4']);
    expect(results[0].score).toBeCloseTo(expected, 5);
  });

  test('multi-query search returns empty instead of falling back when the intersection is empty', async () => {
    seed();

    const { results } = await searchMemoriesMulti({
      db,
      queries: ['puppy', 'pottery'],
      filters: { user_id: 'alice' },
      limit: 10,
    });

    expect(results).toEqual([]);
  });

});
