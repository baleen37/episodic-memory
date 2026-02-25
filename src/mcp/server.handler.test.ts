/**
 * MCP Server Handler Tests
 *
 * Tests for the exported handler functions from handlers.ts.
 * Uses real in-memory DB to avoid mock.module() cross-file leakage.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  handleSearch,
  handleGetObservations,
  handleRead,
} from './handlers.js';
import { resetNormalizerCache } from './normalizer.js';
import {
  SearchInputSchema,
  GetObservationsInputSchema,
  ReadInputSchema,
  shouldRunAsEntrypoint,
  handleError,
} from './server.js';
import { initDatabase, insertObservation } from '../core/db.js';

describe('MCP Server Handlers', () => {
  let db: Database;

  beforeEach(() => {
    process.env.CONVERSATION_MEMORY_DB_PATH = ':memory:';
    db = initDatabase();
    resetNormalizerCache();
  });

  function insertTestObs(opts: {
    title: string;
    content: string;
    project: string;
    timestamp: number;
    sessionId?: string;
  }): number {
    return insertObservation(db, {
      title: opts.title,
      content: opts.content,
      project: opts.project,
      sessionId: opts.sessionId ?? null,
      timestamp: opts.timestamp,
      createdAt: opts.timestamp,
    });
  }

  describe('entrypoint guard', () => {
    test('shouldRunAsEntrypoint returns a boolean', () => {
      expect(typeof shouldRunAsEntrypoint()).toBe('boolean');
    });
  });

  describe('handleSearch', () => {
    test('returns SearchResult[] with id as string', async () => {
      insertTestObs({
        title: 'Test Result',
        content: 'test query content here',
        project: 'test-project',
        timestamp: 1234567890000,
      });

      const params = SearchInputSchema.parse({ query: 'test query content', limit: 10 });
      const results = await handleSearch(params, db, () => null, async () => ({ complete: async () => '' }) as any);

      expect(results.length).toBeGreaterThan(0);
      expect(typeof results[0].id).toBe('string');
      expect(results[0]).toHaveProperty('title');
      expect(results[0]).toHaveProperty('project', 'test-project');
      expect(results[0]).toHaveProperty('timestamp');
    });

    test('returns empty array when no results', async () => {
      const params = SearchInputSchema.parse({ query: 'absolutely_nonexistent_xyz_query' });
      const results = await handleSearch(params, db, () => null, async () => ({ complete: async () => '' }) as any);

      expect(results).toEqual([]);
    });

    test('respects project filter', async () => {
      insertTestObs({ title: 'A', content: 'project filter test', project: 'project-a', timestamp: 1000 });
      insertTestObs({ title: 'B', content: 'project filter test', project: 'project-b', timestamp: 2000 });
      insertTestObs({ title: 'C', content: 'project filter test', project: 'project-c', timestamp: 3000 });

      const params = SearchInputSchema.parse({
        query: 'project filter test',
        projects: ['project-a', 'project-b'],
      });
      const results = await handleSearch(params, db, () => null, async () => ({ complete: async () => '' }) as any);

      expect(results.every(r => ['project-a', 'project-b'].includes(r.project))).toBe(true);
      expect(results.some(r => r.project === 'project-c')).toBe(false);
    });

    test('respects limit', async () => {
      for (let i = 0; i < 15; i++) {
        insertTestObs({ title: `Obs ${i}`, content: 'limit test content here', project: 'p', timestamp: i * 1000 });
      }

      const params = SearchInputSchema.parse({ query: 'limit test content', limit: 5 });
      const results = await handleSearch(params, db, () => null, async () => ({ complete: async () => '' }) as any);

      expect(results.length).toBeLessThanOrEqual(5);
    });
  });

  describe('handleGetObservations', () => {
    test('converts string IDs to numbers', async () => {
      insertTestObs({ title: 'Obs 1', content: 'Content 1', project: 'p', timestamp: 1000 });

      const params = GetObservationsInputSchema.parse({ ids: ['1'] });
      const results = await handleGetObservations(params, db);

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Obs 1');
    });

    test('handles numeric IDs directly', async () => {
      insertTestObs({ title: 'Obs 1', content: 'Content 1', project: 'p1', timestamp: 1000 });
      insertTestObs({ title: 'Obs 2', content: 'Content 2', project: 'p2', timestamp: 2000 });

      const params = GetObservationsInputSchema.parse({ ids: [1, 2] });
      const results = await handleGetObservations(params, db);

      expect(results).toHaveLength(2);
    });

    test('handles mixed string/number IDs', async () => {
      insertTestObs({ title: 'Obs 1', content: 'C', project: 'p', timestamp: 1000 });
      insertTestObs({ title: 'Obs 2', content: 'C', project: 'p', timestamp: 2000 });

      const params = GetObservationsInputSchema.parse({ ids: ['1', 2] });
      const results = await handleGetObservations(params, db);

      expect(results).toHaveLength(2);
    });

    test('returns observation objects with correct fields', async () => {
      const id = insertTestObs({
        title: 'Test Observation',
        content: 'Full content here',
        project: 'my-project',
        sessionId: 'session-123',
        timestamp: 1704067200000,
      });

      const params = GetObservationsInputSchema.parse({ ids: [id] });
      const results = await handleGetObservations(params, db);

      expect(results[0]).toMatchObject({
        id,
        title: 'Test Observation',
        content: 'Full content here',
        project: 'my-project',
        timestamp: 1704067200000,
      });
    });

    test('includes content_original when includeOriginal is true', async () => {
      const id = insertTestObs({
        title: 'Bilingual observation',
        content: 'English canonical summary',
        project: 'my-project',
        timestamp: 1704067200000,
      });
      db.prepare('UPDATE observations SET content_original = ? WHERE id = ?').run('원문 텍스트', id);

      const params = GetObservationsInputSchema.parse({ ids: [id], includeOriginal: true });
      const results = await handleGetObservations(params, db);

      expect(results[0]).toMatchObject({
        id,
        title: 'Bilingual observation',
        content: 'English canonical summary',
        content_original: '원문 텍스트',
        project: 'my-project',
        timestamp: 1704067200000,
      });
    });

    test('returns empty results when no observations found', async () => {
      const params = GetObservationsInputSchema.parse({ ids: [999] });
      const results = await handleGetObservations(params, db);

      expect(results).toEqual([]);
    });

    test('handles multiple observations', async () => {
      insertTestObs({ title: 'First', content: 'C1', project: 'p1', timestamp: 1000 });
      insertTestObs({ title: 'Second', content: 'C2', project: 'p2', timestamp: 2000 });
      insertTestObs({ title: 'Third', content: 'C3', project: 'p3', timestamp: 3000 });

      const params = GetObservationsInputSchema.parse({ ids: [1, 2, 3] });
      const results = await handleGetObservations(params, db);

      expect(results).toHaveLength(3);
      expect(results.map(r => r.id)).toEqual([1, 2, 3]);
    });

    test('does not include content_original by default', async () => {
      const id = insertTestObs({
        title: 'Default output',
        content: 'English summary',
        project: 'my-project',
        timestamp: 1704067200000,
      });
      db.prepare('UPDATE observations SET content_original = ? WHERE id = ?').run('원문 텍스트', id);

      const params = GetObservationsInputSchema.parse({ ids: [id] });
      const results = await handleGetObservations(params, db);

      expect(results[0]).not.toHaveProperty('content_original');
    });
  });

  describe('handleRead', () => {
    test('returns content for valid path', async () => {
      const tempPath = `/tmp/test-read-handler-${Date.now()}.jsonl`;
      await Bun.write(tempPath, JSON.stringify({
        uuid: '1',
        type: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        message: { role: 'user', content: 'Test content' },
      }) + '\n');

      try {
        const params = ReadInputSchema.parse({ path: tempPath });
        const result = handleRead(params);
        expect(typeof result).toBe('string');
      } finally {
        await Bun.file(tempPath).delete();
      }
    });

    test('throws error when file not found', () => {
      const params = ReadInputSchema.parse({ path: '/nonexistent.jsonl' });
      expect(() => handleRead(params)).toThrow('File not found: /nonexistent.jsonl');
    });

    test('accepts startLine param', async () => {
      const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({
        uuid: String(i + 1),
        type: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        message: { role: 'user', content: `Message ${i + 1}` },
      }));
      const tempPath = `/tmp/test-startline-${Date.now()}.jsonl`;
      await Bun.write(tempPath, lines.join('\n') + '\n');

      try {
        const params = ReadInputSchema.parse({ path: tempPath, startLine: 1 });
        const result = handleRead(params);
        expect(typeof result).toBe('string');
      } finally {
        await Bun.file(tempPath).delete();
      }
    });

    test('accepts endLine param', async () => {
      const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({
        uuid: String(i + 1),
        type: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        message: { role: 'user', content: `Message ${i + 1}` },
      }));
      const tempPath = `/tmp/test-endline-${Date.now()}.jsonl`;
      await Bun.write(tempPath, lines.join('\n') + '\n');

      try {
        const params = ReadInputSchema.parse({ path: tempPath, endLine: 3 });
        const result = handleRead(params);
        expect(typeof result).toBe('string');
      } finally {
        await Bun.file(tempPath).delete();
      }
    });
  });

  describe('handleError', () => {
    test('formats Error instance', () => {
      const error = new Error('Something went wrong');
      expect(handleError(error)).toBe('Error: Something went wrong');
    });

    test('formats string error', () => {
      expect(handleError('Simple error message')).toBe('Error: Simple error message');
    });

    test('formats number error', () => {
      expect(handleError(404)).toBe('Error: 404');
    });

    test('formats object error', () => {
      expect(handleError({ code: 'ERR_INVALID' })).toBe('Error: [object Object]');
    });

    test('formats null error', () => {
      expect(handleError(null)).toBe('Error: null');
    });

    test('formats undefined error', () => {
      expect(handleError(undefined)).toBe('Error: undefined');
    });

    test('formats array error', () => {
      expect(handleError(['error1', 'error2'])).toBe('Error: error1,error2');
    });

    test('preserves Error message with colon', () => {
      const error = new Error('Validation failed: field is required');
      expect(handleError(error)).toBe('Error: Validation failed: field is required');
    });
  });
});
