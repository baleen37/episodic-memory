import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleRead, handleSearch } from './handlers.js';
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

  test('maps search results to snake_case memory record fields', async () => {
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
        archive_path: '/archive/claude-projects/session.jsonl',
        line_start: 2,
        line_end: 4,
        source_kind: 'claude-projects',
        project: 'memmem',
        timestamp: Date.UTC(2026, 4, 26),
      },
    ]);
  });

  test('passes source kind filter to search', async () => {
    insertMemoryRecord(db, {
      kind: 'fact',
      text: 'filter memory claude result',
      archivePath: '/archive/claude-projects/session.jsonl',
      lineStart: 1,
      lineEnd: 2,
      sourceKind: 'claude-projects',
      project: null,
      observedAt: Date.UTC(2026, 4, 25),
      dedupeKey: 'filter-claude',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertMemoryRecord(db, {
      kind: 'event',
      text: 'filter memory codex result',
      archivePath: '/archive/codex-sessions/session.jsonl',
      lineStart: 3,
      lineEnd: 4,
      sourceKind: 'codex-sessions',
      project: null,
      observedAt: Date.UTC(2026, 4, 26),
      dedupeKey: 'filter-codex',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    const results = await handleSearch({ query: 'filter memory', limit: 10, source_kind: 'codex-sessions' }, db);

    expect(results).toHaveLength(1);
    expect(results[0].source_kind).toBe('codex-sessions');
    expect(results[0].archive_path).toBe('/archive/codex-sessions/session.jsonl');
  });

  test('reads a transcript file', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-mcp-read-'));
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({
      uuid: '1',
      type: 'user',
      timestamp: '2026-05-26T00:00:00.000Z',
      message: { role: 'user', content: 'Hello' },
    }) + '\n');

    const result = handleRead({ path, startLine: 1, endLine: 1 });

    expect(result).toContain('# Conversation');
    expect(result).toContain('Hello');
  });

  test('throws when transcript file is missing', () => {
    expect(() => handleRead({ path: '/missing/session.jsonl' })).toThrow('File not found: /missing/session.jsonl');
  });
});
