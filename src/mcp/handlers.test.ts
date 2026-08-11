import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { TOOLS } from './tools.js';
import * as handlers from './handlers.js';
import { handleSearch } from './handlers.js';
import { createMemorySchema } from '../core/memory/schema.js';
import { insertMemories } from '../core/memory/store.js';
import { LOCAL_USER_ID } from '../cli/sync.js';
import { __setModelForTests } from '../core/embeddings.js';

describe('MCP surface', () => {
  test('exposes search only', () => {
    expect(TOOLS.map(t => t.name)).toEqual(['search']);
  });
  test('no fetch handler remains', () => {
    expect('handleFetch' in handlers).toBe(false);
  });
  test('search schema advertises the mem0 knobs', () => {
    const props = TOOLS[0].inputSchema.properties as Record<string, unknown>;
    expect(props.query).toBeDefined();
    expect(props.limit).toBeDefined();
    expect(props.threshold).toBeDefined();
    expect(props.explain).toBeDefined();
  });
});

// Deterministic 384-dim embeddings: direction encoded in the first two slots.
function vec(seed: number): number[] {
  const v = new Array(384).fill(0);
  v[0] = Math.cos(seed);
  v[1] = Math.sin(seed);
  return v;
}

describe('handlers', () => {
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

  afterEach(() => {
    db.close();
    __setModelForTests(null, null);
  });

  test('handleSearch scopes to the local user and returns mem0 search results', async () => {
    insertMemories(db, [
      { id: 'm1', memory: 'User adopted a beagle puppy named Max', metadata: { user_id: LOCAL_USER_ID }, embedding: vec(0) },
      { id: 'm2', memory: 'Unrelated fact scoped to a different user', metadata: { user_id: 'someone-else' }, embedding: vec(0) },
    ]);

    const { results } = await handleSearch({ query: 'puppy', limit: 10 }, db);

    expect(results.some(r => r.id === 'm1')).toBe(true);
    expect(results.some(r => r.id === 'm2')).toBe(false);
  });

  test('handleSearch forwards limit, threshold, and explain to searchMemories', async () => {
    insertMemories(db, [
      { id: 'm1', memory: 'User adopted a beagle puppy named Max', metadata: { user_id: LOCAL_USER_ID }, embedding: vec(0) },
    ]);

    const { results } = await handleSearch({ query: 'puppy', limit: 1, threshold: 0, explain: true }, db);

    expect(results).toHaveLength(1);
    expect(results[0].score_details).toBeDefined();
  });

  test('returns an empty result set when nothing matches the scope', async () => {
    const { results } = await handleSearch({ query: 'puppy' }, db);
    expect(results).toEqual([]);
  });
});
