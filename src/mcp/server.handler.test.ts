import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleRead, handleSearch } from './handlers.js';
import { ReadInputSchema, SearchInputSchema, handleError, shouldRunAsEntrypoint } from './server.js';
import { CURRENT_EMBEDDING_VERSION, CURRENT_EXTRACTION_VERSION, initDatabase, insertMemoryRecord } from '../core/db.js';

describe('MCP Server Handlers', () => {
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

  describe('entrypoint guard', () => {
    test('shouldRunAsEntrypoint returns a boolean', () => {
      expect(typeof shouldRunAsEntrypoint()).toBe('boolean');
    });
  });

  describe('handleSearch', () => {
    test('returns memory search results with string IDs', async () => {
      insertMemoryRecord(db, {
        kind: 'event',
        text: 'test query content answer text',
        archivePath: '/archive/claude-projects/session.jsonl',
        lineStart: 1,
        lineEnd: 2,
        sourceKind: 'claude-projects',
        project: 'memmem',
        observedAt: 1234567890000,
        dedupeKey: 'server-handler-test',
        extractionVersion: CURRENT_EXTRACTION_VERSION,
        embeddingVersion: CURRENT_EMBEDDING_VERSION,
      });

      const params = SearchInputSchema.parse({ query: 'test query', limit: 10, source_kind: 'claude-projects' });
      const results = await handleSearch(params, db);

      expect(results).toHaveLength(1);
      expect(typeof results[0].id).toBe('string');
      expect(results[0]).toMatchObject({
        kind: 'event',
        text: 'test query content answer text',
        archive_path: '/archive/claude-projects/session.jsonl',
        line_start: 1,
        line_end: 2,
        source_kind: 'claude-projects',
        project: 'memmem',
        timestamp: 1234567890000,
      });
    });

    test('returns empty array when no memory results exist', async () => {
      const params = SearchInputSchema.parse({ query: 'absolutely_nonexistent_xyz_query' });
      const results = await handleSearch(params, db);

      expect(results).toEqual([]);
    });
  });

  describe('handleRead', () => {
    test('returns content for valid path', () => {
      dir = mkdtempSync(join(tmpdir(), 'memmem-server-read-'));
      const path = join(dir, 'session.jsonl');
      writeFileSync(path, JSON.stringify({
        uuid: '1',
        type: 'user',
        timestamp: '2026-05-26T00:00:00.000Z',
        message: { role: 'user', content: 'Test content' },
      }) + '\n');

      const params = ReadInputSchema.parse({ path });
      const result = handleRead(params);

      expect(result).toContain('Test content');
    });

    test('throws error when file not found', () => {
      const params = ReadInputSchema.parse({ path: '/nonexistent.jsonl' });
      expect(() => handleRead(params)).toThrow('File not found: /nonexistent.jsonl');
    });
  });

  describe('handleError', () => {
    test('formats Error instance', () => {
      expect(handleError(new Error('Something went wrong'))).toBe('Error: Something went wrong');
    });

    test('formats non-Error values', () => {
      expect(handleError('Simple error message')).toBe('Error: Simple error message');
      expect(handleError(404)).toBe('Error: 404');
    });
  });
});
