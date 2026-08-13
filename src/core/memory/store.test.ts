import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createMemorySchema } from './schema.js';
import {
  md5, insertMemories, getExistingHashes, recordHistory, linkEntities, getMemoryRowid,
  deleteMemoriesByRunIds,
} from './store.js';

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

describe('deleteMemoriesByRunIds', () => {
  test('deletes memories, vectors, and fts rows for the matched run_id, leaving unrelated memories untouched', () => {
    const db = freshDb();
    insertMemories(db, [
      { id: 'u1', memory: 'Secret record from purged run', metadata: { run_id: 'purged-run' }, embedding: EMB },
      { id: 'u2', memory: 'Unrelated record from another run', metadata: { run_id: 'kept-run' }, embedding: EMB },
    ]);

    const deleted = deleteMemoriesByRunIds(db, ['purged-run']);
    expect(deleted).toBe(1);

    expect((db.query('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(1);
    expect(db.query('SELECT id FROM memories').get()).toEqual({ id: 'u2' });

    const rowid = getMemoryRowid(db, 'u2')!;
    expect((db.query('SELECT COUNT(*) c FROM vec_memories').get() as { c: number }).c).toBe(1);
    expect((db.query('SELECT COUNT(*) c FROM vec_memories WHERE rowid = ?').get(rowid) as { c: number }).c).toBe(1);

    const ftsHits = db.query('SELECT rowid FROM fts_memories WHERE fts_memories MATCH ?').all('unrelated') as Array<{ rowid: number }>;
    expect(ftsHits).toHaveLength(1);
    expect(ftsHits[0].rowid).toBe(rowid);

    const purgedFtsHits = db.query('SELECT rowid FROM fts_memories WHERE fts_memories MATCH ?').all('secret') as Array<{ rowid: number }>;
    expect(purgedFtsHits).toHaveLength(0);
  });

  test('strips deleted memory ids from entity links and drops entities left empty', () => {
    const db = freshDb();
    const unitVec = (idx: number): number[] => {
      const v = new Array(384).fill(0);
      v[idx] = 1;
      return v;
    };
    insertMemories(db, [
      { id: 'm1', memory: 'fact from purged run', metadata: { run_id: 'purged-run' }, embedding: EMB },
      { id: 'm2', memory: 'fact from kept run', metadata: { run_id: 'kept-run' }, embedding: EMB },
    ]);
    linkEntities(db, [
      { data: 'OnlyPurged', entity_type: null, memory_ids: ['m1'], embedding: unitVec(0) },
      { data: 'Shared', entity_type: null, memory_ids: ['m1', 'm2'], embedding: unitVec(1) },
    ], { user_id: 'local' });

    deleteMemoriesByRunIds(db, ['purged-run']);

    const rows = db.query('SELECT data, linked_memory_ids FROM entities ORDER BY data').all() as
      Array<{ data: string; linked_memory_ids: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toBe('Shared');
    expect(JSON.parse(rows[0].linked_memory_ids)).toEqual(['m2']);
    expect((db.query('SELECT COUNT(*) c FROM vec_entities').get() as { c: number }).c).toBe(1);
  });

  test('handles an empty run_id list without touching the store', () => {
    const db = freshDb();
    insertMemories(db, [{ id: 'u1', memory: 'kept', metadata: { run_id: 'r' }, embedding: EMB }]);
    expect(deleteMemoriesByRunIds(db, [])).toBe(0);
    expect((db.query('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(1);
  });

  test('handles run_ids that match nothing', () => {
    const db = freshDb();
    insertMemories(db, [{ id: 'u1', memory: 'kept', metadata: { run_id: 'r' }, embedding: EMB }]);
    expect(deleteMemoriesByRunIds(db, ['no-such-run'])).toBe(0);
    expect((db.query('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(1);
  });
});

describe('linkEntities', () => {
  const SCOPE = { user_id: 'local', agent_id: 'claude-projects', run_id: 'r1' };

  function unitVec(idx: number): number[] {
    const v = new Array(384).fill(0);
    v[idx] = 1;
    return v;
  }

  function allEntities(db: Database): Array<Record<string, string>> {
    return db.query('SELECT * FROM entities ORDER BY data').all() as Array<Record<string, string>>;
  }

  test('inserts a new entity with scope metadata, links, and a vector row', () => {
    const db = freshDb();
    linkEntities(db, [{ data: 'Poppy', entity_type: 'PROPER', memory_ids: ['m1'], embedding: unitVec(0) }], SCOPE);

    const rows = allEntities(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toBe('Poppy');
    expect(rows[0].entity_type).toBe('PROPER');
    expect(JSON.parse(rows[0].linked_memory_ids)).toEqual(['m1']);
    expect(JSON.parse(rows[0].metadata)).toEqual(SCOPE);
    expect((db.query('SELECT COUNT(*) c FROM vec_entities').get() as { c: number }).c).toBe(1);
  });

  test('merges linked ids on exact normalized text match', () => {
    const db = freshDb();
    linkEntities(db, [{ data: 'Poppy', entity_type: 'PROPER', memory_ids: ['m1'], embedding: unitVec(0) }], SCOPE);
    // Different casing/whitespace and a dissimilar embedding: exact match wins first.
    linkEntities(db, [{ data: '  poppy ', entity_type: 'PROPER', memory_ids: ['m2'], embedding: unitVec(1) }], SCOPE);

    const rows = allEntities(db);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].linked_memory_ids)).toEqual(['m1', 'm2']);
  });

  test('merges linked ids on semantic match at or above 0.95', () => {
    const db = freshDb();
    linkEntities(db, [{ data: 'Poppy', entity_type: 'PROPER', memory_ids: ['m1'], embedding: unitVec(0) }], SCOPE);
    linkEntities(db, [{ data: 'Poppy the dog', entity_type: 'PROPER', memory_ids: ['m2'], embedding: unitVec(0) }], SCOPE);

    const rows = allEntities(db);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].linked_memory_ids)).toEqual(['m1', 'm2']);
  });

  test('inserts a separate entity when text differs and similarity is below 0.95', () => {
    const db = freshDb();
    linkEntities(db, [{ data: 'Poppy', entity_type: 'PROPER', memory_ids: ['m1'], embedding: unitVec(0) }], SCOPE);
    linkEntities(db, [{ data: 'Shopify', entity_type: 'PROPER', memory_ids: ['m2'], embedding: unitVec(1) }], SCOPE);

    expect(allEntities(db)).toHaveLength(2);
  });

  test('does not match entities from a different scope', () => {
    const db = freshDb();
    linkEntities(db, [{ data: 'Poppy', entity_type: 'PROPER', memory_ids: ['m1'], embedding: unitVec(0) }], SCOPE);
    linkEntities(db, [{ data: 'Poppy', entity_type: 'PROPER', memory_ids: ['m2'], embedding: unitVec(0) }],
      { ...SCOPE, run_id: 'r2' });

    const rows = allEntities(db);
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].linked_memory_ids)).toEqual(['m1']);
    expect(JSON.parse(rows[1].linked_memory_ids)).toEqual(['m2']);
  });
});
