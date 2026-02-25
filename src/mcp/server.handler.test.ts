/**
 * MCP Server Handler Tests
 *
 * Tests for the exported handler functions from handlers.ts.
 * These tests execute the actual handler code with mocked dependencies.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  handleSearch,
  handleGetObservations,
  handleRead,
  resetQueryNormalizerCache,
} from './handlers.js';
import {
  SearchInputSchema,
  GetObservationsInputSchema,
  ReadInputSchema,
  shouldRunAsEntrypoint,
  handleError,
} from './server.js';

const mockSearch: any = mock(async () => []);
const mockFindByIds: any = mock(async () => []);
const mockReadConversation: any = mock(() => null);
const mockLoadConfig: any = mock(() => null);
const mockCreateProvider: any = mock(async () => ({ complete: mock(async () => ({ text: '', usage: { input_tokens: 0, output_tokens: 0 } })) }));

// Mock the core modules
mock.module('../core/search.js', () => ({
  search: mockSearch,
}));

mock.module('../core/db.js', () => ({
  getObservationsByIds: mockFindByIds,
}));

mock.module('../core/read.js', () => ({
  readConversation: mockReadConversation,
}));

describe('MCP Server Handlers', () => {
  let mockDb: Database;

  beforeEach(() => {
    mockSearch.mockClear();
    mockFindByIds.mockClear();
    mockReadConversation.mockClear();
    mockLoadConfig.mockClear();
    mockCreateProvider.mockClear();
    resetQueryNormalizerCache();

    mockDb = {} as Database;
  });

  describe('entrypoint guard', () => {
    test('shouldRunAsEntrypoint returns a boolean', () => {
      expect(typeof shouldRunAsEntrypoint()).toBe('boolean');
    });
  });

  describe('handleSearch', () => {
    test('returns SearchResult[] with valid params', async () => {
      mockSearch.mockImplementation(async () => [
        { id: 1, title: 'Test Result', project: 'test-project', timestamp: 1234567890 },
        { id: 2, title: 'Another Result', project: 'test-project', timestamp: 1234567900 },
      ]);

      const params = SearchInputSchema.parse({
        query: 'test query',
        limit: 10,
      });

      const results = await handleSearch(params, mockDb, mockLoadConfig, mockCreateProvider);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        id: '1',
        title: 'Test Result',
        project: 'test-project',
        timestamp: 1234567890,
      });
    });

    test('passes params correctly to search function', async () => {
      mockSearch.mockImplementation(async () => []);

      const params = SearchInputSchema.parse({
        query: 'search term',
        limit: 25,
        after: '2024-01-01',
        before: '2024-12-31',
        projects: ['project-a', 'project-b'],
        files: ['/path/to/file.ts'],
      });

      await handleSearch(params, mockDb, mockLoadConfig, mockCreateProvider);

      expect(mockSearch).toHaveBeenCalledWith('search term', expect.objectContaining({
        db: mockDb,
        limit: 25,
        after: '2024-01-01',
        before: '2024-12-31',
        projects: ['project-a', 'project-b'],
        files: ['/path/to/file.ts'],
      }));
    });

    test('formats results with id as string', async () => {
      mockSearch.mockImplementation(async () => [
        { id: 999, title: 'Numeric ID', project: 'p', timestamp: 1 },
      ]);

      const params = SearchInputSchema.parse({ query: 'test' });
      const results = await handleSearch(params, mockDb, mockLoadConfig, mockCreateProvider);

      expect(results[0].id).toBe('999');
      expect(typeof results[0].id).toBe('string');
    });

    test('returns empty array when no results', async () => {
      mockSearch.mockImplementation(async () => []);

      const params = SearchInputSchema.parse({ query: 'nonexistent' });
      const results = await handleSearch(params, mockDb, mockLoadConfig, mockCreateProvider);

      expect(results).toEqual([]);
    });

    test('uses default limit when not specified', async () => {
      mockSearch.mockImplementation(async () => []);

      const params = SearchInputSchema.parse({ query: 'test' });
      await handleSearch(params, mockDb, mockLoadConfig, mockCreateProvider);

      expect(mockSearch).toHaveBeenCalledWith('test', expect.objectContaining({
        limit: 10,
      }));
    });
  });

  describe('handleGetObservations', () => {
    test('converts string IDs to numbers', async () => {
      mockFindByIds.mockImplementation(async () => [
        { id: 1, title: 'Obs 1', content: 'Content 1', project: 'p', sessionId: null, contentOriginal: null, timestamp: 1000 },
      ]);

      const params = GetObservationsInputSchema.parse({ ids: ['1', '2'] });
      const results = await handleGetObservations(params, mockDb);

      expect(mockFindByIds).toHaveBeenCalledWith(mockDb, [1, 2]);
      expect(results).toHaveLength(1);
    });

    test('handles numeric IDs directly', async () => {
      mockFindByIds.mockImplementation(async () => [
        { id: 10, title: 'Obs 10', content: 'Content 10', project: 'p', sessionId: null, contentOriginal: null, timestamp: 2000 },
        { id: 20, title: 'Obs 20', content: 'Content 20', project: 'p', sessionId: null, contentOriginal: null, timestamp: 3000 },
      ]);

      const params = GetObservationsInputSchema.parse({ ids: [10, 20] });
      const results = await handleGetObservations(params, mockDb);

      expect(mockFindByIds).toHaveBeenCalledWith(mockDb, [10, 20]);
      expect(results).toHaveLength(2);
    });

    test('handles mixed string/number IDs', async () => {
      mockFindByIds.mockImplementation(async () => [
        { id: 1, title: 'Obs', content: 'C', project: 'p', sessionId: null, contentOriginal: null, timestamp: 1000 },
      ]);

      const params = GetObservationsInputSchema.parse({ ids: ['1', 2, '3'] });
      await handleGetObservations(params, mockDb);

      expect(mockFindByIds).toHaveBeenCalledWith(mockDb, [1, 2, 3]);
    });

    test('returns observation objects with correct fields', async () => {
      mockFindByIds.mockImplementation(async () => [
        {
          id: 42,
          title: 'Test Observation',
          content: 'Full content here',
          project: 'my-project',
          sessionId: 'session-123',
          contentOriginal: null,
          timestamp: 1704067200000,
        },
      ]);

      const params = GetObservationsInputSchema.parse({ ids: [42] });
      const results = await handleGetObservations(params, mockDb);

      expect(results[0]).toEqual({
        id: 42,
        title: 'Test Observation',
        content: 'Full content here',
        project: 'my-project',
        timestamp: 1704067200000,
      });
    });

    test('includes content_original when includeOriginal is true', async () => {
      mockFindByIds.mockImplementation(async () => [
        {
          id: 7,
          title: 'Bilingual observation',
          content: 'English canonical summary',
          contentOriginal: '원문 텍스트',
          project: 'my-project',
          sessionId: 'session-123',
          timestamp: 1704067200000,
        },
      ]);

      const params = GetObservationsInputSchema.parse({ ids: [7], includeOriginal: true });
      const results = await handleGetObservations(params, mockDb);

      expect(results[0]).toEqual({
        id: 7,
        title: 'Bilingual observation',
        content: 'English canonical summary',
        content_original: '원문 텍스트',
        project: 'my-project',
        timestamp: 1704067200000,
      });
    });

    test('returns empty results when no observations found', async () => {
      mockFindByIds.mockImplementation(async () => []);

      const params = GetObservationsInputSchema.parse({ ids: [999] });
      const results = await handleGetObservations(params, mockDb);

      expect(results).toEqual([]);
    });

    test('handles multiple observations', async () => {
      mockFindByIds.mockImplementation(async () => [
        { id: 1, title: 'First', content: 'C1', project: 'p1', sessionId: null, contentOriginal: null, timestamp: 1000 },
        { id: 2, title: 'Second', content: 'C2', project: 'p2', sessionId: null, contentOriginal: null, timestamp: 2000 },
        { id: 3, title: 'Third', content: 'C3', project: 'p3', sessionId: null, contentOriginal: null, timestamp: 3000 },
      ]);

      const params = GetObservationsInputSchema.parse({ ids: [1, 2, 3] });
      const results = await handleGetObservations(params, mockDb);

      expect(results).toHaveLength(3);
      expect(results.map(r => r.id)).toEqual([1, 2, 3]);
    });

    test('does not include content_original by default', async () => {
      mockFindByIds.mockImplementation(async () => [
        {
          id: 8,
          title: 'Default output',
          content: 'English summary',
          contentOriginal: '원문 텍스트',
          project: 'my-project',
          sessionId: null,
          timestamp: 1704067200000,
        },
      ]);

      const params = GetObservationsInputSchema.parse({ ids: [8] });
      const results = await handleGetObservations(params, mockDb);

      expect(results[0]).toEqual({
        id: 8,
        title: 'Default output',
        content: 'English summary',
        project: 'my-project',
        timestamp: 1704067200000,
      });
      expect(results[0]).not.toHaveProperty('content_original');
    });
  });

  describe('handleRead', () => {
    test('returns content for valid path', () => {
      mockReadConversation.mockImplementation(() => '# Conversation\n\nTest content');

      const params = ReadInputSchema.parse({ path: '/valid/path.jsonl' });
      const result = handleRead(params);

      expect(result).toBe('# Conversation\n\nTest content');
      expect(mockReadConversation).toHaveBeenCalledWith('/valid/path.jsonl', undefined, undefined);
    });

    test('passes pagination params (startLine, endLine)', () => {
      mockReadConversation.mockImplementation(() => '# Page content');

      const params = ReadInputSchema.parse({
        path: '/file.jsonl',
        startLine: 10,
        endLine: 50,
      });
      const result = handleRead(params);

      expect(mockReadConversation).toHaveBeenCalledWith('/file.jsonl', 10, 50);
      expect(result).toBe('# Page content');
    });

    test('throws error when file not found', () => {
      mockReadConversation.mockImplementation(() => null);

      const params = ReadInputSchema.parse({ path: '/nonexistent.jsonl' });

      expect(() => handleRead(params)).toThrow('File not found: /nonexistent.jsonl');
    });

    test('handles startLine only', () => {
      mockReadConversation.mockImplementation(() => '# From line 10');

      const params = ReadInputSchema.parse({
        path: '/file.jsonl',
        startLine: 10,
      });
      handleRead(params);

      expect(mockReadConversation).toHaveBeenCalledWith('/file.jsonl', 10, undefined);
    });

    test('handles endLine only', () => {
      mockReadConversation.mockImplementation(() => '# Until line 50');

      const params = ReadInputSchema.parse({
        path: '/file.jsonl',
        endLine: 50,
      });
      handleRead(params);

      expect(mockReadConversation).toHaveBeenCalledWith('/file.jsonl', undefined, 50);
    });

    test('propagates empty string result', () => {
      mockReadConversation.mockImplementation(() => '');

      const params = ReadInputSchema.parse({ path: '/empty.jsonl' });
      const result = handleRead(params);

      expect(result).toBe('');
    });
  });

  describe('handleError', () => {
    test('formats Error instance', () => {
      const error = new Error('Something went wrong');
      const result = handleError(error);

      expect(result).toBe('Error: Something went wrong');
    });

    test('formats string error', () => {
      const result = handleError('Simple error message');

      expect(result).toBe('Error: Simple error message');
    });

    test('formats number error', () => {
      const result = handleError(404);

      expect(result).toBe('Error: 404');
    });

    test('formats object error', () => {
      const result = handleError({ code: 'ERR_INVALID' });

      expect(result).toBe('Error: [object Object]');
    });

    test('formats null error', () => {
      const result = handleError(null);

      expect(result).toBe('Error: null');
    });

    test('formats undefined error', () => {
      const result = handleError(undefined);

      expect(result).toBe('Error: undefined');
    });

    test('formats array error', () => {
      const result = handleError(['error1', 'error2']);

      expect(result).toBe('Error: error1,error2');
    });

    test('preserves Error message with colon', () => {
      const error = new Error('Validation failed: field is required');
      const result = handleError(error);

      expect(result).toBe('Error: Validation failed: field is required');
    });
  });
});
