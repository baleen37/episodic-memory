import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleFetch, handleSearch } from './handlers.js';
import { CURRENT_EMBEDDING_VERSION, CURRENT_EXTRACTION_VERSION, initDatabase, insertMemoryRecord } from '../core/db.js';

describe('handlers', () => {
  let db: Database;
  let dir: string | null = null;

  beforeEach(() => {
    process.env.TEST_DB_PATH = ':memory:';
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    delete process.env.TEST_DB_PATH;
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
  });

  test('maps search results to compact memory cards', async () => {
    insertMemoryRecord(db, {
      kind: 'fact',
      text: 'memory search transcript result',
      archivePath: '/archive/claude-projects/session.jsonl',
      lineStart: 2,
      lineEnd: 4,
      sourceKind: 'claude-projects',
      project: 'memmem',
      observedAt: Date.UTC(2026, 4, 26),
      dedupeKey: 'test-memory-search',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    const results = await handleSearch({ query: 'memory search', limit: 10 }, db);

    expect(results).toEqual([
      {
        id: '1',
        kind: 'fact',
        text: 'memory search transcript result',
      },
    ]);
  });

  test('fetch returns the source transcript for a record id', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-mcp-fetch-'));
    const archivePath = join(dir, 'session.jsonl');
    writeFileSync(archivePath, JSON.stringify({
      uuid: '1',
      type: 'user',
      timestamp: '2026-05-26T00:00:00.000Z',
      message: { role: 'user', content: 'Hello from transcript' },
    }) + '\n');

    insertMemoryRecord(db, {
      kind: 'fact',
      text: 'fetchable memory record',
      archivePath,
      lineStart: 1,
      lineEnd: 1,
      sourceKind: 'claude-projects',
      project: null,
      observedAt: Date.UTC(2026, 4, 26),
      dedupeKey: 'fetchable',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    const result = handleFetch({ id: 1 }, db);

    expect(result).toContain('# Conversation');
    expect(result).toContain('Hello from transcript');
  });

  test('fetch accepts a string id', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-mcp-fetch-str-'));
    const archivePath = join(dir, 'session.jsonl');
    writeFileSync(archivePath, JSON.stringify({
      uuid: '1',
      type: 'user',
      timestamp: '2026-05-26T00:00:00.000Z',
      message: { role: 'user', content: 'String id transcript' },
    }) + '\n');

    insertMemoryRecord(db, {
      kind: 'fact',
      text: 'string id memory record',
      archivePath,
      lineStart: 1,
      lineEnd: 1,
      sourceKind: 'claude-projects',
      project: null,
      observedAt: Date.UTC(2026, 4, 26),
      dedupeKey: 'string-id',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    expect(handleFetch({ id: '1' }, db)).toContain('String id transcript');
  });

  test('fetch throws when the record id is unknown', () => {
    expect(() => handleFetch({ id: 999 }, db)).toThrow('Memory record not found: 999');
  });
});
