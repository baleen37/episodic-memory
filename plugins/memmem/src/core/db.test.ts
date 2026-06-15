import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  CURRENT_EMBEDDING_VERSION,
  CURRENT_EXTRACTION_VERSION,
  createObservation,
  deleteMemoryIndexForArchivePath,
  getAllPendingEvents,
  getObservation,
  getObservationById,
  getObservationsByIds,
  getRecentObservations,
  initDatabase,
  isWipeAllowed,
  insertMemoryRecord,
  insertMemoryRecordVector,
  insertObservation,
  insertPendingEvent,
  migrateExtractionStateForTests,
  searchObservations,
  upsertExtractionState,
  hasCompletedExtractionState,
  getExtractionAttemptCount,
} from './db.js';

let db: ReturnType<typeof initDatabase> | null = null;

function openTestDatabase(): NonNullable<typeof db> {
  process.env.TEST_DB_PATH = ':memory:';
  db = initDatabase();
  return db;
}

afterEach(() => {
  db?.close();
  db = null;
});

describe('memory record database schema', () => {
  test('creates memory record tables and indexes', () => {
    const db = openTestDatabase();

    const rows = db.query(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'index', 'virtual')
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const names = rows.map(row => row.name);

    expect(names).toContain('memory_records');
    expect(names).toContain('vec_memory_records');
    expect(names).toContain('extraction_state');
    expect(names).toContain('idx_memory_records_dedupe_key');
    expect(names).toContain('idx_memory_records_status');
    expect(names).toContain('idx_memory_records_archive_path');
    expect(names).toContain('idx_extraction_state_archive_path');
    expect(names).toContain('idx_extraction_state_status');
  });

  test('upserts memory records by scoped dedupe key and stores vectors', () => {
    const db = openTestDatabase();

    const id = insertMemoryRecord(db, {
      kind: 'fact',
      text: 'memmem stores fact and event memory records.',
      sourceKind: 'claude-projects',
      archivePath: '/archive/a.jsonl',
      lineStart: 1,
      lineEnd: 3,
      observedAt: 1780272000000,
      project: 'memmem',
      projectName: null,
      confidence: 0.9,
      dedupeKey: 'fact:memmem-memory-records',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    insertMemoryRecordVector(db, id, Array.from({ length: 384 }, () => 0.01));
    insertMemoryRecordVector(db, id, Array.from({ length: 384 }, () => 0.02));

    const memory = db.query('SELECT id, kind, text FROM memory_records WHERE dedupe_key = ?')
      .get('fact:memmem-memory-records') as { id: number; kind: string; text: string };
    expect(memory.id).toBe(id);
    expect(memory.kind).toBe('fact');

    const vector = db.query('SELECT rowid FROM vec_memory_records WHERE rowid = ?').get(id) as { rowid: number } | null;
    expect(vector?.rowid).toBe(id);

    upsertExtractionState(db, {
      sourceKind: 'claude-projects',
      archivePath: '/archive/unrelated.jsonl',
      lineStart: 20,
      lineEnd: 25,
      sourceHash: 'unrelated-hash',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      status: 'done',
    });

    const sameId = insertMemoryRecord(db, {
      kind: 'fact',
      text: 'memmem stores compact fact and event memory records.',
      sourceKind: 'claude-projects',
      archivePath: '/archive/a.jsonl',
      lineStart: 1,
      lineEnd: 3,
      observedAt: 1780272000000,
      project: 'memmem',
      projectName: null,
      dedupeKey: 'fact:memmem-memory-records',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
    });
    expect(sameId).toBe(id);

    const updated = db.query('SELECT text FROM memory_records WHERE id = ?').get(id) as { text: string };
    expect(updated.text).toBe('memmem stores compact fact and event memory records.');

    const differentSpanId = insertMemoryRecord(db, {
      kind: 'fact',
      text: 'memmem stores fact and event memory records.',
      sourceKind: 'claude-projects',
      archivePath: '/archive/b.jsonl',
      lineStart: 1,
      lineEnd: 3,
      observedAt: 1780272000000,
      project: 'memmem',
      projectName: null,
      dedupeKey: 'fact:memmem-memory-records',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
    });
    expect(differentSpanId).not.toBe(id);

    const count = db.query('SELECT COUNT(*) AS count FROM memory_records WHERE dedupe_key = ?')
      .get('fact:memmem-memory-records') as { count: number };
    expect(count.count).toBe(2);
  });

  test('upserts extraction state and detects completed unchanged spans', () => {
    const db = openTestDatabase();

    upsertExtractionState(db, {
      sourceKind: 'claude-projects',
      archivePath: '/archive/state.jsonl',
      lineStart: 4,
      lineEnd: 8,
      sourceHash: 'hash-1',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      status: 'errored',
      errorMessage: 'temporary failure',
      retryAfter: 1780272000000,
    });
    expect(hasCompletedExtractionState(db, '/archive/state.jsonl', 4, 8, 'hash-1', CURRENT_EXTRACTION_VERSION)).toBe(false);

    upsertExtractionState(db, {
      sourceKind: 'claude-projects',
      archivePath: '/archive/state.jsonl',
      lineStart: 4,
      lineEnd: 8,
      sourceHash: 'hash-1',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      status: 'done',
    });

    expect(hasCompletedExtractionState(db, '/archive/state.jsonl', 4, 8, 'hash-1', CURRENT_EXTRACTION_VERSION)).toBe(true);
    const count = db.query('SELECT COUNT(*) AS count FROM extraction_state').get() as { count: number };
    expect(count.count).toBe(1);
  });

  test('deletes memory records, vectors, and extraction state for an archive path', () => {
    const db = openTestDatabase();

    const id = insertMemoryRecord(db, {
      kind: 'event',
      text: 'The user approved event fact memory architecture.',
      sourceKind: 'claude-projects',
      archivePath: '/archive/b.jsonl',
      lineStart: 10,
      lineEnd: 12,
      observedAt: 1780272000000,
      project: null,
      projectName: null,
      dedupeKey: 'event:approval',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
    });
    insertMemoryRecordVector(db, id, Array.from({ length: 384 }, () => 0.02));
    upsertExtractionState(db, {
      sourceKind: 'claude-projects',
      archivePath: '/archive/b.jsonl',
      lineStart: 10,
      lineEnd: 12,
      sourceHash: 'abc',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      status: 'done',
    });

    deleteMemoryIndexForArchivePath(db, '/archive/b.jsonl');

    expect(db.query('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
    expect(db.query('SELECT COUNT(*) AS count FROM vec_memory_records').get()).toEqual({ count: 0 });
    expect(db.query('SELECT COUNT(*) AS count FROM extraction_state').get()).toEqual({ count: 0 });
  });

  test('extraction_state has attempt_count column with default 0', () => {
    const db = openTestDatabase();
    const cols = db.query('PRAGMA table_info(extraction_state)').all() as Array<{ name: string; dflt_value: string }>;
    const attempt = cols.find((c) => c.name === 'attempt_count');
    expect(attempt).toBeDefined();
    expect(attempt!.dflt_value).toBe('0');
  });

  test('migration adds attempt_count to a pre-existing table missing it', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE extraction_state (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_kind TEXT NOT NULL, archive_path TEXT NOT NULL,
          line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
          source_hash TEXT NOT NULL, extraction_version INTEGER NOT NULL,
          status TEXT NOT NULL, error_message TEXT, retry_after INTEGER,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(archive_path, line_start, line_end, source_hash, extraction_version)
        )
      `);
      migrateExtractionStateForTests(db); // must be safe to call twice
      migrateExtractionStateForTests(db);
      const cols = db.query('PRAGMA table_info(extraction_state)').all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'attempt_count')).toBe(true);
    } finally {
      db.close();
    }
  });

  test('upsertExtractionState persists attempt_count', () => {
    const db = openTestDatabase();
    upsertExtractionState(db, {
      sourceKind: 'claude-projects', archivePath: '/a.jsonl',
      lineStart: 1, lineEnd: 5, sourceHash: 'h1', extractionVersion: 1,
      status: 'errored', attemptCount: 3, retryAfter: 999,
    });
    const row = db.query(
      'SELECT attempt_count AS attemptCount FROM extraction_state WHERE archive_path = ?'
    ).get('/a.jsonl') as { attemptCount: number };
    expect(row.attemptCount).toBe(3);
  });

  test('upsertExtractionState defaults attempt_count to 0 when omitted', () => {
    const db = openTestDatabase();
    upsertExtractionState(db, {
      sourceKind: 'claude-projects', archivePath: '/b.jsonl',
      lineStart: 1, lineEnd: 5, sourceHash: 'h1', extractionVersion: 1,
      status: 'done',
    });
    const row = db.query(
      'SELECT attempt_count AS attemptCount FROM extraction_state WHERE archive_path = ?'
    ).get('/b.jsonl') as { attemptCount: number };
    expect(row.attemptCount).toBe(0);
  });

  test('getExtractionAttemptCount returns current count, 0 when missing', () => {
    const db = openTestDatabase();
    // missing span → 0
    expect(getExtractionAttemptCount(db, '/x.jsonl', 1, 5, 'h1', 1)).toBe(0);

    upsertExtractionState(db, {
      sourceKind: 'claude-projects', archivePath: '/x.jsonl',
      lineStart: 1, lineEnd: 5, sourceHash: 'h1', extractionVersion: 1,
      status: 'errored', attemptCount: 4, retryAfter: 999,
    });
    expect(getExtractionAttemptCount(db, '/x.jsonl', 1, 5, 'h1', 1)).toBe(4);
  });

  test('legacy observation schema exports fail with explicit removed-schema errors', async () => {
    const db = openTestDatabase();

    expect(() => insertPendingEvent(db, {
      sessionId: 'session-1',
      project: 'project-a',
      toolName: 'Read',
      summary: 'Read file',
      timestamp: 1710000000000,
      createdAt: 1710000000000,
    })).toThrow('Observation schema has been removed');
    expect(() => insertObservation(db, {
      title: 'Legacy observation',
      content: 'Legacy content',
      project: 'project-a',
      timestamp: 1710000000000,
      createdAt: 1710000000000,
    })).toThrow('Observation schema has been removed');
    await expect(createObservation(db, 'Legacy observation', 'Legacy content', 'project-a')).rejects.toThrow('Observation schema has been removed');
    expect(() => getAllPendingEvents(db, 'session-1')).toThrow('Observation schema has been removed');
    expect(() => getRecentObservations(db)).toThrow('Observation schema has been removed');
    expect(() => searchObservations(db)).toThrow('Observation schema has been removed');
    expect(() => getObservationById(db, 1)).toThrow('Observation schema has been removed');
    expect(() => getObservation(db, 1)).toThrow('Observation schema has been removed');
    expect(() => getObservationsByIds(db, [1])).toThrow('Observation schema has been removed');
  });
});

describe('isWipeAllowed wipe guard', () => {
  test('allows wipe in bun test env', () => {
    expect(isWipeAllowed(true, undefined)).toBe(true);
  });

  test('allows wipe when NODE_ENV is test', () => {
    expect(isWipeAllowed(false, 'test')).toBe(true);
  });

  test('blocks wipe in production env', () => {
    expect(isWipeAllowed(false, 'production')).toBe(false);
  });

  test('blocks wipe when NODE_ENV is undefined and not test env', () => {
    expect(isWipeAllowed(false, undefined)).toBe(false);
  });
});

test('sets WAL safety pragmas', () => {
  const database = openTestDatabase();
  const busy = database.query('PRAGMA busy_timeout').get() as { timeout: number };
  expect(busy.timeout).toBe(5000);
  const sync = database.query('PRAGMA synchronous').get() as { synchronous: number };
  expect(sync.synchronous).toBe(1); // 1 = NORMAL
});
