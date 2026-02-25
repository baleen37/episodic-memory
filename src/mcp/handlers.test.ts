/**
 * Tests for MCP tool handlers
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  handleSearch,
  handleGetObservations,
  handleRead,
  type SearchResult,
} from './handlers.js';
import { initDatabase, insertObservation } from '../core/db.js';
import { EMBEDDING_DIM } from '../core/constants.js';

describe('handlers', () => {
  let db: Database;

  beforeEach(() => {
    // Use in-memory database for testing
    process.env.CONVERSATION_MEMORY_DB_PATH = ':memory:';
    db = initDatabase();
  });

  // Helper to create a EMBEDDING_DIM-dimensional test embedding
  function createTestEmbedding(seed: number = 0): number[] {
    return Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(seed + i * 0.1) * 0.5 + 0.5);
  }

  // Helper to insert test observation
  function insertTestObservation(
    db: Database,
    observation: {
      title: string;
      content: string;
      project: string;
      sessionId?: string;
      timestamp: number;
    },
    embedding?: number[]
  ): number {
    return insertObservation(db, {
      title: observation.title,
      content: observation.content,
      project: observation.project,
      sessionId: observation.sessionId ?? undefined,
      timestamp: observation.timestamp,
      createdAt: observation.timestamp
    }, embedding);
  }

  describe('handleSearch', () => {
    test('returns empty array when no results', async () => {
      const results = await handleSearch(
        { query: 'nonexistent', limit: 10 },
        db,
        () => null, // no config
        async () => ({ complete: async () => '' }) as any
      );

      expect(results).toEqual([]);
    });

    test('returns formatted search results', async () => {
      // Insert test observation
      insertTestObservation(db, {
        title: 'Test Title',
        content: 'Test content',
        project: 'test-project',
        timestamp: 1704067200000
      }, createTestEmbedding(1));

      const results = await handleSearch(
        { query: 'Test', limit: 10 },
        db,
        () => null,
        async () => ({ complete: async () => '' }) as any
      );

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('id');
      expect(results[0]).toHaveProperty('title');
      expect(results[0]).toHaveProperty('project');
      expect(results[0]).toHaveProperty('timestamp');
    });
  });

  describe('handleGetObservations', () => {
    test('returns empty array for nonexistent IDs', async () => {
      const results = await handleGetObservations(
        { ids: [99999], includeOriginal: false },
        db
      );

      expect(results).toEqual([]);
    });

    test('returns observations by IDs', async () => {
      // Insert test observation
      insertTestObservation(db, {
        title: 'Test',
        content: 'Content',
        project: 'project',
        timestamp: 1704067200000
      });

      const observations = await handleGetObservations(
        { ids: [1], includeOriginal: false },
        db
      );

      expect(observations).toHaveLength(1);
      expect(observations[0].title).toBe('Test');
      expect(observations[0].content).toBe('Content');
    });

    test('includes content_original when requested', async () => {
      insertTestObservation(db, {
        title: 'Test',
        content: 'Content',
        project: 'project',
        timestamp: 1704067200000
      });

      // Update to add content_original
      db.exec(`
        UPDATE observations SET content_original = 'Original content' WHERE id = 1
      `);

      const observations = await handleGetObservations(
        { ids: [1], includeOriginal: true },
        db
      );

      expect(observations[0].content_original).toBe('Original content');
    });
  });

  describe('handleRead', () => {
    test('throws error for nonexistent file', () => {
      expect(() => handleRead({ path: '/nonexistent/file.jsonl' })).toThrow('File not found');
    });

    test('returns content for existing file', async () => {
      // Create temp file
      const tempPath = `/tmp/test-conversation-${Date.now()}.jsonl`;
      await Bun.write(tempPath, JSON.stringify({
        uuid: '1',
        type: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        message: { role: 'user', content: 'Hello' }
      }) + '\n');

      try {
        const result = handleRead({ path: tempPath });
        expect(result).toContain('# Conversation');
      } finally {
        await Bun.file(tempPath).delete();
      }
    });
  });
});
