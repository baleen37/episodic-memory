import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createMemorySchema } from './schema.js';

function freshDb(): Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  createMemorySchema(db);
  return db;
}

describe('createMemorySchema', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('creates the three mem0 stores plus search indexes', () => {
    const names = (db.query("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>)
      .map(r => r.name);
    expect(names).toContain('memories');
    expect(names).toContain('history');
    expect(names).toContain('entities');
    expect(names).toContain('vec_memories');
    expect(names).toContain('fts_memories');
  });

  test('memories carries the MemoryItem columns', () => {
    const cols = (db.query('PRAGMA table_info(memories)').all() as Array<{ name: string; type: string }>);
    const byName = Object.fromEntries(cols.map(c => [c.name, c.type]));
    expect(byName.id).toBe('TEXT');
    expect(byName.memory).toBe('TEXT');
    expect(byName.hash).toBe('TEXT');
    expect(byName.metadata).toBe('TEXT');
    expect(byName.created_at).toBe('INTEGER');
    expect(byName.updated_at).toBe('INTEGER');
    // score is computed at search time, never stored
    expect(byName.score).toBeUndefined();
  });

  test('hash is unique so md5 dedup is enforced by the DB', () => {
    const ins = 'INSERT INTO memories (id, memory, hash, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?)';
    db.query(ins).run('id-1', 'a fact', 'deadbeef', '{}', 1, 1);
    expect(() => db.query(ins).run('id-2', 'a fact', 'deadbeef', '{}', 2, 2)).toThrow();
  });

  test('is idempotent', () => {
    expect(() => { createMemorySchema(db); createMemorySchema(db); }).not.toThrow();
  });

  test('fts_memories matches on English text via bm25', () => {
    db.query('INSERT INTO memories (id, memory, hash, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('id-1', 'User replaced the embedding model', 'h1', '{}', 1, 1);
    const rowid = (db.query('SELECT rowid AS r FROM memories WHERE id = ?').get('id-1') as { r: number }).r;
    db.query('INSERT INTO fts_memories(rowid, text_lemmatized) VALUES (?, ?)')
      .run(rowid, 'user replaced the embedding model');
    const hits = db.query('SELECT rowid, bm25(fts_memories) AS s FROM fts_memories WHERE fts_memories MATCH ?')
      .all('embedding') as Array<{ rowid: number; s: number }>;
    expect(hits).toHaveLength(1);
    expect(hits[0].rowid).toBe(rowid);
  });

  test('history records an append-only trail', () => {
    db.query('INSERT INTO history (memory_id, old_memory, new_memory, event, created_at, is_deleted) VALUES (?,?,?,?,?,?)')
      .run('id-1', null, 'a fact', 'ADD', 1, 0);
    const rows = db.query('SELECT * FROM history').all() as Array<{ event: string }>;
    expect(rows[0].event).toBe('ADD');
  });
});
