import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CURRENT_EMBEDDING_VERSION, CURRENT_EXTRACTION_VERSION, initDatabase, insertMemoryRecord, insertMemoryRecordVector } from './db.js';
import { getMemoryStats } from './stats.js';

let db: Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
  delete process.env.TEST_DB_PATH;
});

describe('getMemoryStats', () => {
  test('counts memory records and vectors', () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();

    const id = insertMemoryRecord(db, {
      kind: 'fact',
      text: 'memmem stores atomic fact memory records.',
      sourceKind: 'claude-code-projects',
      archivePath: '/archive/a.jsonl',
      lineStart: 1,
      lineEnd: 3,
      observedAt: 1780272000000,
      project: null,
      projectName: null,
      dedupeKey: 'fact:stats-memory-record',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertMemoryRecordVector(db, id, Array.from({ length: 384 }, () => 0.01));

    const stats = getMemoryStats(db);

    expect(stats.totalMemoryRecords).toBe(1);
    expect(stats.activeMemoryRecords).toBe(1);
    expect(stats.factCount).toBe(1);
    expect(stats.eventCount).toBe(0);
    expect(stats.vectorizedRecords).toBe(1);
    expect(stats.missingVectors).toBe(0);
    expect(stats.topProjects).toEqual([{ project: '(unknown)', count: 1 }]);
  });
});
