import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CURRENT_EXTRACTION_VERSION, initDatabase, insertMemoryRecord } from './db.js';
import { verifyMemoryIndex } from './verify.js';

describe('verifyMemoryIndex', () => {
  test('detects invalid provenance and missing vectors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memmem-verify-'));
    const archivePath = join(dir, 'archive.jsonl');
    writeFileSync(archivePath, 'line 1\nline 2\n');

    const db = initDatabase();
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
