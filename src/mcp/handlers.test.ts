import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { TOOLS } from './tools.js';
import * as handlers from './handlers.js';
import { handleRead, handleSearch } from './handlers.js';
import { compactMemoryId, expandMemoryId } from './ids.js';
import { createMemorySchema } from '../core/memory/schema.js';
import { insertMemories } from '../core/memory/store.js';
import { LOCAL_USER_ID } from '../core/constants.js';
import { __setModelForTests } from '../core/embeddings.js';

describe('MCP surface', () => {
  test('exposes search only', () => {
    expect(TOOLS.map(t => t.name)).toEqual(['search', 'read']);
  });
  test('no fetch handler remains', () => {
    expect('handleFetch' in handlers).toBe(false);
  });
  test('search schema exposes only query and limit', () => {
    const props = TOOLS[0].inputSchema.properties as Record<string, unknown>;
    expect(props.query).toBeDefined();
    expect(props.limit).toBeDefined();
    expect(props.threshold).toBeUndefined();
    expect(props.explain).toBeUndefined();
  });

  test('search schema advertises array queries for strict AND search', () => {
    const props = TOOLS[0].inputSchema.properties as Record<string, unknown>;
    expect(props.query).toMatchObject({ anyOf: expect.any(Array) });
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

  test('handleSearch scopes to the local user and returns compact cards', async () => {
    insertMemories(db, [
      { id: 'm1', memory: 'User adopted a beagle puppy named Max', metadata: { user_id: LOCAL_USER_ID }, embedding: vec(0) },
      { id: 'm2', memory: 'Unrelated fact scoped to a different user', metadata: { user_id: 'someone-else' }, embedding: vec(0) },
    ]);

    const { results } = await handleSearch({ query: 'puppy', limit: 10 }, db);

    expect(results.some(r => r.id === compactMemoryId('m1'))).toBe(true);
    expect(results.some(r => r.id === 'm2')).toBe(false);
    expect(results[0]).toEqual(expect.objectContaining({
      id: compactMemoryId('m1'),
      text: expect.any(String),
      date: expect.any(String),
      score: expect.any(Number),
    }));
    expect(results[0]).not.toHaveProperty('metadata');
    expect(results[0]).not.toHaveProperty('hash');
  });

  test('handleRead reads multiple local records in requested order', async () => {
    insertMemories(db, [
      { id: 'm1', memory: 'User adopted a beagle puppy named Max', metadata: { user_id: LOCAL_USER_ID }, embedding: vec(0) },
      { id: 'm2', memory: 'User started pottery classes', metadata: { user_id: LOCAL_USER_ID }, embedding: vec(1.5) },
    ]);

    const result = await handleRead({ ids: [compactMemoryId('m2'), compactMemoryId('m1')] }, db);

    expect(result.results.map(row => row.id)).toEqual([compactMemoryId('m2'), compactMemoryId('m1')]);
    expect(result.results.map(row => row.text)).toEqual([
      'User started pottery classes',
      'User adopted a beagle puppy named Max',
    ]);
    expect(result.missing).toEqual([]);
  });

  test('handleRead reports unknown and out-of-scope records as missing', async () => {
    insertMemories(db, [
      { id: 'other', memory: 'Private other user record', metadata: { user_id: 'someone-else' }, embedding: vec(0) },
    ]);

    const result = await handleRead({ ids: ['missing', compactMemoryId('other')] }, db);

    expect(result.results).toEqual([]);
    expect(result.missing).toEqual(['missing', compactMemoryId('other')]);
  });

  test('returns an empty result set when nothing matches the scope', async () => {
    const { results } = await handleSearch({ query: 'puppy' }, db);
    expect(results).toEqual([]);
  });

  test('handleSearch returns only records matching every query', async () => {
    insertMemories(db, [
      { id: 'm1', memory: 'User adopted a beagle puppy named Max', metadata: { user_id: LOCAL_USER_ID }, embedding: vec(0) },
      { id: 'm2', memory: 'User started pottery classes on Tuesdays', metadata: { user_id: LOCAL_USER_ID }, embedding: vec(1.5) },
      { id: 'm3', memory: 'User combined puppy care with pottery classes', metadata: { user_id: LOCAL_USER_ID }, embedding: vec(0.75) },
    ]);

    const params = { query: ['puppy', 'pottery'], limit: 10 } as Parameters<typeof handleSearch>[0];
    const { results } = await handleSearch(params, db);

    expect(results.map(result => expandMemoryId(result.id))).toEqual(['m3']);
  });
});
