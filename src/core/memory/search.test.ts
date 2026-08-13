import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createMemorySchema } from './schema.js';
import { insertMemories } from './store.js';
import { searchMemories } from './search.js';
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
      db, query: 'pottery', filters: { user_id: 'alice' }, explain: true,
    });
    expect(results[0].id).toBe('m2');
    expect(results[0].score_details!.bm25_score).toBeGreaterThan(0);
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
      db, query: 'pottery zzzznomatch', filters: { user_id: 'alice' }, explain: true,
    });
    expect(results[0].id).toBe('m2');
    expect(results[0].score_details!.bm25_score).toBeGreaterThan(0);
  });

  test('ranks a scoped lexical candidate outside semantic KNN', async () => {
    __setModelForTests(async () => {}, async (_kind, text) => {
      if (text.includes('rareorchidtoken')) return vec(0);
      return vec(3.0);
    });
    const distractors = Array.from({ length: 80 }, (_, i) => ({
      id: `closer-${i}`,
      memory: `Closer semantic distractor ${i} about deployments`,
      metadata: { user_id: 'local' },
      embedding: vec(1.0),
    }));
    const filler = Array.from({ length: 200 }, (_, i) => ({
      id: `filler-${i}`,
      memory: `Filler record ${i} about servers and deployments`,
      metadata: { user_id: 'local' },
      embedding: vec(1.5),
    }));
    insertMemories(db, [
      ...distractors,
      ...filler,
      {
        id: 'lexical-target',
        memory: 'The Orchid deployment uses rareorchidtoken for lexical retrieval',
        metadata: { user_id: 'local' },
        embedding: vec(3.0),
      },
      {
        id: 'other-user-lexical-target',
        memory: 'The Orchid deployment uses rareorchidtoken for lexical retrieval',
        metadata: { user_id: 'someone-else' },
        embedding: vec(3.0),
      },
    ]);

    const { results } = await searchMemories({
      db, query: 'rareorchidtoken', filters: { user_id: 'local' }, limit: 1, explain: true,
    });

    expect(results[0].id).toBe('lexical-target');
    expect(results[0].score_details!.semantic_score).toBe(0);
    expect(results[0].score_details!.bm25_score).toBeGreaterThan(0);
    expect(results.map(result => result.id)).not.toContain('other-user-lexical-target');
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
});
