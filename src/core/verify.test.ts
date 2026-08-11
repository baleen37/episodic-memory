import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createMemorySchema } from './memory/schema.js';
import { verifyMemoryIndex } from './verify.js';

function newMemoryDb(): Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  createMemorySchema(db);
  return db;
}

let db: Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function insertMemory(database: Database, id: string, memory: string): void {
  database.query(
    'INSERT INTO memories (id, memory, hash, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run(id, memory, `hash-${id}`, '{}', Date.now(), Date.now());
}

function insertVector(database: Database, rowid: number): void {
  database.query('INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)').run(
    rowid, Buffer.from(new Float32Array(Array.from({ length: 384 }, () => 0.01)).buffer),
  );
}

describe('verifyMemoryIndex', () => {
  test('counts total memories and detects missing vectors', () => {
    db = newMemoryDb();

    insertMemory(db, 'mem-1', 'A memory without a vector.');

    const result = verifyMemoryIndex(db);

    expect(result.totalMemories).toBe(1);
    expect(result.missingVectors).toEqual([{ id: 'mem-1' }]);
    expect(result.orphanVectors).toEqual([]);
  });

  test('detects orphan vectors with no matching memory row', () => {
    db = newMemoryDb();

    insertMemory(db, 'mem-1', 'A memory with a vector.');
    const rowid = (db.query('SELECT rowid AS r FROM memories WHERE id = ?').get('mem-1') as { r: number }).r;
    insertVector(db, rowid);
    insertVector(db, rowid + 1); // orphan: no memories row at this rowid

    const result = verifyMemoryIndex(db);

    expect(result.missingVectors).toEqual([]);
    expect(result.orphanVectors).toEqual([{ rowid: rowid + 1 }]);
  });

  test('reports zero issues for a fully vectorized index', () => {
    db = newMemoryDb();

    insertMemory(db, 'mem-1', 'Fully indexed memory.');
    const rowid = (db.query('SELECT rowid AS r FROM memories WHERE id = ?').get('mem-1') as { r: number }).r;
    insertVector(db, rowid);

    const result = verifyMemoryIndex(db);

    expect(result.totalMemories).toBe(1);
    expect(result.missingVectors).toEqual([]);
    expect(result.orphanVectors).toEqual([]);
  });
});
