import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { handleSearch } from './handlers.js';
import { SearchInputSchema, handleError, shouldRunAsEntrypoint } from './server.js';
import { createMemorySchema } from '../core/memory/schema.js';
import { insertMemories } from '../core/memory/store.js';
import { LOCAL_USER_ID } from '../core/constants.js';
import { __setModelForTests } from '../core/embeddings.js';

function vec(seed: number): number[] {
  const v = new Array(384).fill(0);
  v[0] = Math.cos(seed);
  v[1] = Math.sin(seed);
  return v;
}

describe('MCP Server Handlers', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    sqliteVec.load(db);
    createMemorySchema(db);
    __setModelForTests(async () => {}, async (_kind, text) => {
      if (text.includes('test query')) return vec(0);
      return vec(3.0);
    });
  });

  afterEach(() => {
    db.close();
    __setModelForTests(null, null);
  });

  describe('entrypoint guard', () => {
    test('shouldRunAsEntrypoint returns a boolean', () => {
      expect(typeof shouldRunAsEntrypoint()).toBe('boolean');
    });
  });

  describe('handleSearch', () => {
    test('returns memory search results with string IDs', async () => {
      insertMemories(db, [
        { id: 'm1', memory: 'test query content answer text', metadata: { user_id: LOCAL_USER_ID }, embedding: vec(0) },
      ]);

      const params = SearchInputSchema.parse({ query: 'test query', limit: 10 });
      const { results } = await handleSearch(params, db);

      expect(results).toHaveLength(1);
      expect(typeof results[0].id).toBe('string');
      expect(results[0].memory).toBe('test query content answer text');
      expect(results[0]).not.toHaveProperty('archive_path');
      expect(results[0]).not.toHaveProperty('source');
      expect(results[0]).not.toHaveProperty('next_action');
      expect(results[0]).not.toHaveProperty('timestamp');
    });

    test('returns empty array when no memory results exist', async () => {
      const params = SearchInputSchema.parse({ query: 'absolutely_nonexistent_xyz_query' });
      const { results } = await handleSearch(params, db);

      expect(results).toEqual([]);
    });

    test('threshold and explain are optional and forwarded when present', async () => {
      insertMemories(db, [
        { id: 'm1', memory: 'test query content answer text', metadata: { user_id: LOCAL_USER_ID }, embedding: vec(0) },
      ]);

      const params = SearchInputSchema.parse({ query: 'test query', threshold: 0, explain: true });
      const { results } = await handleSearch(params, db);

      expect(results[0].score_details).toBeDefined();
    });
  });

  describe('module surface', () => {
    test('no fetch handler remains', async () => {
      const handlers = await import('./handlers.js');
      expect('handleFetch' in handlers).toBe(false);
    });
  });

  describe('handleError', () => {
    test('formats Error instance', () => {
      expect(handleError(new Error('Something went wrong'))).toBe('Error: Something went wrong');
    });

    test('formats non-Error values', () => {
      expect(handleError('Simple error message')).toBe('Error: Simple error message');
      expect(handleError(404)).toBe('Error: 404');
    });
  });
});
