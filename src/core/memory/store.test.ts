import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createMemorySchema } from './schema.js';
import { md5, insertMemories, getExistingHashes, recordHistory, upsertEntities, getMemoryRowid } from './store.js';

const EMB = new Array(384).fill(0.1);

function freshDb(): Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  createMemorySchema(db);
  return db;
}

describe('md5', () => {
  test('is stable and content-addressed', () => {
    expect(md5('a fact')).toBe(md5('a fact'));
    expect(md5('a fact')).not.toBe(md5('another fact'));
    expect(md5('a fact')).toHaveLength(32);
  });
});

describe('insertMemories', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('inserts a new memory with hash and metadata', () => {
    const res = insertMemories(db, [
      { id: 'u1', memory: 'User adopted a puppy', metadata: { user_id: 'alice' }, embedding: EMB },
    ]);
    expect(res.inserted).toEqual(['u1']);
    const row = db.query('SELECT * FROM memories WHERE id = ?').get('u1') as Record<string, string>;
    expect(row.memory).toBe('User adopted a puppy');
    expect(row.hash).toBe(md5('User adopted a puppy'));
    expect(JSON.parse(row.metadata).user_id).toBe('alice');
  });

  test('skips duplicates by md5 instead of raising', () => {
    insertMemories(db, [{ id: 'u1', memory: 'same text', metadata: null, embedding: EMB }]);
    const res = insertMemories(db, [{ id: 'u2', memory: 'same text', metadata: null, embedding: EMB }]);
    expect(res.inserted).toEqual([]);
    expect(res.skipped).toEqual(['u2']);
    expect((db.query('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(1);
  });

  test('dedups within a single batch', () => {
    const res = insertMemories(db, [
      { id: 'u1', memory: 'dup', metadata: null, embedding: EMB },
      { id: 'u2', memory: 'dup', metadata: null, embedding: EMB },
    ]);
    expect(res.inserted).toEqual(['u1']);
    expect(res.skipped).toEqual(['u2']);
  });

  test('writes vector and fts rows keyed to the memory rowid', () => {
    insertMemories(db, [{ id: 'u1', memory: 'Embedding model swapped', metadata: null, embedding: EMB }]);
    const rowid = getMemoryRowid(db, 'u1')!;
    expect((db.query('SELECT COUNT(*) c FROM vec_memories WHERE rowid = ?').get(rowid) as { c: number }).c).toBe(1);
    const hits = db.query('SELECT rowid FROM fts_memories WHERE fts_memories MATCH ?').all('embedding') as Array<{ rowid: number }>;
    expect(hits[0].rowid).toBe(rowid);
  });

  test('handles an empty batch', () => {
    expect(insertMemories(db, [])).toEqual({ inserted: [], skipped: [] });
  });
});

describe('getExistingHashes', () => {
  test('returns only hashes already stored', () => {
    const db = freshDb();
    insertMemories(db, [{ id: 'u1', memory: 'stored', metadata: null, embedding: EMB }]);
    const found = getExistingHashes(db, [md5('stored'), md5('absent')]);
    expect(found.has(md5('stored'))).toBe(true);
    expect(found.has(md5('absent'))).toBe(false);
  });
  test('handles an empty input', () => {
    expect(getExistingHashes(freshDb(), []).size).toBe(0);
  });
});

describe('recordHistory', () => {
  test('appends ADD entries', () => {
    const db = freshDb();
    recordHistory(db, [{ memory_id: 'u1', old_memory: null, new_memory: 'a fact', event: 'ADD' }]);
    const rows = db.query('SELECT * FROM history').all() as Array<{ event: string; new_memory: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('ADD');
    expect(rows[0].new_memory).toBe('a fact');
  });
});

describe('upsertEntities', () => {
  test('stores entities with their linked memory ids', () => {
    const db = freshDb();
    upsertEntities(db, [{ id: 'e1', data: 'Max', entity_type: 'PET', linked_memory_ids: ['u1'], embedding: EMB }]);
    const row = db.query('SELECT * FROM entities WHERE id = ?').get('e1') as Record<string, string>;
    expect(row.data).toBe('Max');
    expect(JSON.parse(row.linked_memory_ids)).toEqual(['u1']);
  });

  test('merges linked ids when the entity already exists', () => {
    const db = freshDb();
    upsertEntities(db, [{ id: 'e1', data: 'Max', entity_type: 'PET', linked_memory_ids: ['u1'], embedding: EMB }]);
    upsertEntities(db, [{ id: 'e1', data: 'Max', entity_type: 'PET', linked_memory_ids: ['u2'], embedding: EMB }]);
    const row = db.query('SELECT linked_memory_ids AS l FROM entities WHERE id = ?').get('e1') as { l: string };
    expect(JSON.parse(row.l).sort()).toEqual(['u1', 'u2']);
  });
});
