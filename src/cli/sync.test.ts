/**
 * Tests for sync.ts: reindex missing embeddings in vec_observations.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase, insertObservation } from '../core/db.js';
import { __setModelForTests } from '../core/embeddings.js';
import { syncEmbeddings, type SyncResult } from './sync.js';

function makeObs(db: Database, title: string, withEmbedding = false) {
  const embedding = withEmbedding ? new Array(384).fill(0.1) : undefined;
  return insertObservation(
    db,
    { title, content: 'test content', project: 'test', timestamp: Date.now(), createdAt: Date.now() },
    embedding,
  );
}

describe('syncEmbeddings', () => {
  let db: Database;

  beforeEach(() => {
    process.env.CONVERSATION_MEMORY_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(
      async () => {},
      async (_text: string) => new Array(384).fill(0.5),
    );
  });

  afterEach(() => {
    __setModelForTests(null, null);
    if (db) db.close();
  });

  test('returns zero counts when all observations already have embeddings', async () => {
    makeObs(db, 'obs1', true);
    makeObs(db, 'obs2', true);

    const result: SyncResult = await syncEmbeddings(db);

    expect(result.total).toBe(2);
    expect(result.synced).toBe(0);
    expect(result.failed).toBe(0);
  });

  test('generates embeddings for observations missing from vec_observations', async () => {
    makeObs(db, 'obs-no-embedding', false);

    const result: SyncResult = await syncEmbeddings(db);

    expect(result.total).toBe(1);
    expect(result.synced).toBe(1);
    expect(result.failed).toBe(0);

    const vecCount = (db.query('SELECT COUNT(*) as cnt FROM vec_observations').get() as { cnt: number }).cnt;
    expect(vecCount).toBe(1);
  });

  test('skips observations that already have embeddings', async () => {
    makeObs(db, 'has-embedding', true);
    makeObs(db, 'no-embedding', false);

    const result: SyncResult = await syncEmbeddings(db);

    expect(result.total).toBe(2);
    expect(result.synced).toBe(1);
    expect(result.failed).toBe(0);
  });

  test('counts failed when embedding generation returns null', async () => {
    __setModelForTests(
      async () => {},
      async (_text: string) => { throw new Error('model error'); },
    );
    makeObs(db, 'obs-will-fail', false);

    const result: SyncResult = await syncEmbeddings(db);

    expect(result.total).toBe(1);
    expect(result.synced).toBe(0);
    expect(result.failed).toBe(1);
  });

  test('returns zero counts on empty database', async () => {
    const result: SyncResult = await syncEmbeddings(db);

    expect(result.total).toBe(0);
    expect(result.synced).toBe(0);
    expect(result.failed).toBe(0);
  });
});
