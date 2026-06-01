import { describe, expect, test } from 'bun:test';
import { CURRENT_EMBEDDING_VERSION, CURRENT_EXTRACTION_VERSION, initDatabase, insertMemoryRecord, insertMemoryRecordVector } from './db.js';
import { getMemoryStats } from './stats.js';

describe('getMemoryStats', () => {
  test('counts memory records and vectors', () => {
    const db = initDatabase();

    const id = insertMemoryRecord(db, {
      kind: 'fact',
      text: 'memmem stores atomic fact memory records.',
      sourceKind: 'claude-projects',
      archivePath: '/archive/a.jsonl',
      lineStart: 1,
      lineEnd: 3,
      observedAt: 1780272000000,
      project: 'memmem',
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
  });
});
