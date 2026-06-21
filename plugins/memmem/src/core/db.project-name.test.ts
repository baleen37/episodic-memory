import { beforeAll, describe, expect, test } from 'bun:test';
import { initDatabase, insertMemoryRecord } from './db.js';

beforeAll(() => {
  // Isolate from the real config DB — initDatabase() wipes whatever path it resolves.
  process.env.TEST_DB_PATH = ':memory:';
});

describe('insertMemoryRecord persists project_name', () => {
  test('stores and returns project + project_name', () => {
    const db = initDatabase();
    const id = insertMemoryRecord(db, {
      kind: 'fact',
      text: 'hello',
      sourceKind: 'claude-code-projects',
      archivePath: '/a/b.jsonl',
      lineStart: 1,
      lineEnd: 2,
      observedAt: null,
      project: 'croquis/memmem',
      projectName: 'memmem',
      dedupeKey: 'k1',
      extractionVersion: 1,
    });
    const row = db
      .query('SELECT project, project_name AS projectName FROM memory_records WHERE id = ?')
      .get(id) as { project: string; projectName: string };
    expect(row).toEqual({ project: 'croquis/memmem', projectName: 'memmem' });
    db.close();
  });
});
