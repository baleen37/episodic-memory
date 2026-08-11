import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createMemorySchema } from './memory/schema.js';
import { getMemoryStats } from './stats.js';

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

describe('getMemoryStats', () => {
  test('counts memories and vectors', () => {
    db = newMemoryDb();

    insertMemory(db, 'mem-1', 'memmem stores atomic memory records.');
    const rowid = (db.query('SELECT rowid AS r FROM memories WHERE id = ?').get('mem-1') as { r: number }).r;
    insertVector(db, rowid);
    insertMemory(db, 'mem-2', 'A memory without a vector yet.');

    const stats = getMemoryStats(db);

    expect(stats.totalMemories).toBe(2);
    expect(stats.vectorizedMemories).toBe(1);
    expect(stats.missingVectors).toBe(1);
  });

  test('reports zeros for an empty index', () => {
    db = newMemoryDb();

    const stats = getMemoryStats(db);

    expect(stats.totalMemories).toBe(0);
    expect(stats.vectorizedMemories).toBe(0);
    expect(stats.missingVectors).toBe(0);
  });
});
