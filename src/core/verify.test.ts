import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CURRENT_EXTRACTION_VERSION, initDatabase, insertMemoryRecord } from './db.js';
import { verifyMemoryIndex } from './verify.js';

let db: Database | null = null;
let dir: string | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  delete process.env.TEST_DB_PATH;
});

describe('verifyMemoryIndex', () => {
  test('detects invalid provenance and missing vectors', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-verify-'));
    const archivePath = join(dir, 'archive.jsonl');
    writeFileSync(archivePath, 'line 1\nline 2\n');

    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    const id = insertMemoryRecord(db, {
      kind: 'fact',
      text: 'A memory record should point to existing archive lines.',
      sourceKind: 'claude-projects',
      archivePath,
      lineStart: 1,
      lineEnd: 99,
      observedAt: null,
      project: null,
      dedupeKey: 'fact:invalid-provenance',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
    });

    const result = verifyMemoryIndex(db);

    expect(result.invalidProvenance).toEqual([{ id, archivePath, lineStart: 1, lineEnd: 99 }]);
    expect(result.missingVectors).toEqual([{ id, archivePath }]);
  });
});
