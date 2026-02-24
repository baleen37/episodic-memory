/**
 * Tests for SessionStart hook - token-budgeted injection of recent observations.
 *
 * This hook is responsible for:
 * 1. Reading config (maxObservations, maxTokens, recencyDays, projectOnly)
 * 2. Querying recent observations for the project
 * 3. Formatting as markdown
 * 4. Respecting token budget (stops when maxTokens reached)
 * 5. Returning formatted markdown for injection
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase, insertObservation, getObservation } from '../core/db.js';
import { handleSessionStart, type SessionStartConfig, type SessionStartResult } from './session-start.js';
import { EMBEDDING_DIM } from '../core/constants.js';

// Use vi.hoisted to create mock embedding array before vi.mock is hoisted
// Note: Cannot use EMBEDDING_DIM here due to hoisting constraints
const mockEmbeddingForMock = vi.hoisted(() => new Array(384).fill(0.1));

// Mock embeddings module
vi.mock('../core/embeddings.js', () => ({
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  generateEmbedding: vi.fn().mockResolvedValue(mockEmbeddingForMock),
}));

// Real embedding array for insertObservation calls - uses constant
const mockEmbedding = new Array(EMBEDDING_DIM).fill(0.1);

describe('SessionStart Hook', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Use in-memory database for testing
    process.env.CONVERSATION_MEMORY_DB_PATH = ':memory:';
    db = initDatabase();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  describe('handleSessionStart', () => {
    test('should return empty result when no observations exist', async () => {
      const config: SessionStartConfig = {
        maxObservations: 20,
        maxTokens: 500,
        recencyDays: 7,
        projectOnly: true,
      };

      const result = await handleSessionStart(db, 'test-project', config);

      expect(result.markdown).toBe('');
      expect(result.includedCount).toBe(0);
      expect(result.tokenCount).toBe(0);
    });

    test('should format observations as markdown with header', async () => {
      // Create test observation
      insertObservation(
        db,
        {
          title: 'Fixed auth bug',
          content: 'Resolved JWT validation issue in login flow',
          project: 'test-project',
          sessionId: 'session-123',
          timestamp: Date.now(),
          createdAt: Date.now(),
        },
        mockEmbedding
      );

      const config: SessionStartConfig = {
        maxObservations: 20,
        maxTokens: 500,
        recencyDays: 7,
        projectOnly: true,
      };

      const result = await handleSessionStart(db, 'test-project', config);

      expect(result.markdown).toContain('# test-project recent context (memmem)');
      expect(result.markdown).toContain('- Fixed auth bug: Resolved JWT validation issue in login flow');
      expect(result.includedCount).toBe(1);
    });

    test('should include multiple observations', async () => {
      // Create multiple observations
      const observations = [
        { title: 'Fixed auth bug', content: 'Resolved JWT validation issue' },
        { title: 'Added rate limiting', content: 'Implemented Redis-backed rate limiting for API' },
        { title: 'Updated tests', content: 'Increased test coverage to 85%' },
      ];

      for (const obs of observations) {
        insertObservation(
          db,
          {
            title: obs.title,
            content: obs.content,
            project: 'test-project',
            sessionId: 'session-123',
            timestamp: Date.now(),
            createdAt: Date.now(),
          },
          mockEmbedding
        );
      }

      const config: SessionStartConfig = {
        maxObservations: 20,
        maxTokens: 500,
        recencyDays: 7,
        projectOnly: true,
      };

      const result = await handleSessionStart(db, 'test-project', config);

      expect(result.markdown).toContain('- Fixed auth bug: Resolved JWT validation issue');
      expect(result.markdown).toContain('- Added rate limiting: Implemented Redis-backed rate limiting for API');
      expect(result.markdown).toContain('- Updated tests: Increased test coverage to 85%');
      expect(result.includedCount).toBe(3);
    });

    test('should respect maxObservations limit', async () => {
      // Create 5 observations
      for (let i = 0; i < 5; i++) {
        insertObservation(
          db,
          {
            title: `Observation ${i}`,
            content: `Content ${i}`,
            project: 'test-project',
            sessionId: 'session-123',
            timestamp: Date.now(),
            createdAt: Date.now(),
          },
          mockEmbedding
        );
      }

      const config: SessionStartConfig = {
        maxObservations: 3,
        maxTokens: 500,
        recencyDays: 7,
        projectOnly: true,
      };

      const result = await handleSessionStart(db, 'test-project', config);

      expect(result.includedCount).toBe(3);
    });

    test('should respect maxTokens budget', async () => {
      // Create observations with varying content lengths
      const shortContent = 'Short';
      const longContent = 'This is a very long content that uses many tokens '.repeat(10);

      insertObservation(
        db,
        { title: 'Short obs', content: shortContent, project: 'test-project', sessionId: 'session-123', timestamp: Date.now(), createdAt: Date.now() },
        mockEmbedding
      );

      insertObservation(
        db,
        { title: 'Long obs', content: longContent, project: 'test-project', sessionId: 'session-123', timestamp: Date.now(), createdAt: Date.now() },
        mockEmbedding
      );

      const config: SessionStartConfig = {
        maxObservations: 20,
        maxTokens: 100, // Small budget
        recencyDays: 7,
        projectOnly: true,
      };

      const result = await handleSessionStart(db, 'test-project', config);

      // Should stop before exceeding budget
      expect(result.tokenCount).toBeLessThanOrEqual(100);
      // Token count approximation: header + first observation line
      expect(result.includedCount).toBeGreaterThanOrEqual(0);
    });

    test('should filter by project when projectOnly is true', async () => {
      // Create observations for different projects
      insertObservation(
        db,
        { title: 'Project A obs', content: 'Content A', project: 'project-a', sessionId: 'session-123', timestamp: Date.now(), createdAt: Date.now() },
        mockEmbedding
      );

      insertObservation(
        db,
        { title: 'Project B obs', content: 'Content B', project: 'project-b', sessionId: 'session-123', timestamp: Date.now(), createdAt: Date.now() },
        mockEmbedding
      );

      const config: SessionStartConfig = {
        maxObservations: 20,
        maxTokens: 500,
        recencyDays: 7,
        projectOnly: true,
      };

      const result = await handleSessionStart(db, 'project-a', config);

      expect(result.markdown).toContain('Project A obs');
      expect(result.markdown).not.toContain('Project B obs');
      expect(result.includedCount).toBe(1);
    });

    test('should include all projects when projectOnly is false', async () => {
      // Create observations for different projects
      insertObservation(
        db,
        { title: 'Project A obs', content: 'Content A', project: 'project-a', sessionId: 'session-123', timestamp: Date.now(), createdAt: Date.now() },
        mockEmbedding
      );

      insertObservation(
        db,
        { title: 'Project B obs', content: 'Content B', project: 'project-b', sessionId: 'session-123', timestamp: Date.now(), createdAt: Date.now() },
        mockEmbedding
      );

      const config: SessionStartConfig = {
        maxObservations: 20,
        maxTokens: 500,
        recencyDays: 7,
        projectOnly: false,
      };

      const result = await handleSessionStart(db, 'project-a', config);

      expect(result.markdown).toContain('Project A obs');
      expect(result.markdown).toContain('Project B obs');
      expect(result.includedCount).toBe(2);
    });

    test('should filter by recencyDays', async () => {
      const now = Date.now();
      const dayInMs = 24 * 60 * 60 * 1000;

      // Create old observation (10 days ago)
      insertObservation(
        db,
        { title: 'Old obs', content: 'Old content', project: 'test-project', sessionId: 'session-123', timestamp: now - 10 * dayInMs, createdAt: now - 10 * dayInMs },
        mockEmbedding
      );

      // Create recent observation (2 days ago)
      insertObservation(
        db,
        { title: 'Recent obs', content: 'Recent content', project: 'test-project', sessionId: 'session-123', timestamp: now - 2 * dayInMs, createdAt: now - 2 * dayInMs },
        mockEmbedding
      );

      const config: SessionStartConfig = {
        maxObservations: 20,
        maxTokens: 500,
        recencyDays: 7,
        projectOnly: true,
      };

      const result = await handleSessionStart(db, 'test-project', config);

      expect(result.markdown).toContain('Recent obs');
      expect(result.markdown).not.toContain('Old obs');
      expect(result.includedCount).toBe(1);
    });

    test('should count tokens accurately', async () => {
      // Create observation with known content
      const content = 'This content has specific token count';
      insertObservation(
        db,
        { title: 'Test', content: content, project: 'test-project', sessionId: 'session-123', timestamp: Date.now(), createdAt: Date.now() },
        mockEmbedding
      );

      const config: SessionStartConfig = {
        maxObservations: 20,
        maxTokens: 500,
        recencyDays: 7,
        projectOnly: true,
      };

      const result = await handleSessionStart(db, 'test-project', config);

      // Token count should be calculated using char/4 approximation
      // Header + bullet point format
      expect(result.tokenCount).toBeGreaterThan(0);
      expect(result.markdown.length).toBeGreaterThan(0);
    });

    test('should handle empty content gracefully', async () => {
      insertObservation(
        db,
        { title: 'No content', content: '', project: 'test-project', sessionId: 'session-123', timestamp: Date.now(), createdAt: Date.now() },
        mockEmbedding
      );

      const config: SessionStartConfig = {
        maxObservations: 20,
        maxTokens: 500,
        recencyDays: 7,
        projectOnly: true,
      };

      const result = await handleSessionStart(db, 'test-project', config);

      expect(result.markdown).toContain('- No content:');
      expect(result.includedCount).toBe(1);
    });

    test('should return results ordered by recency', async () => {
      const now = Date.now();

      // Create observations with different timestamps
      insertObservation(
        db,
        { title: 'First', content: 'First content', project: 'test-project', sessionId: 'session-123', timestamp: now - 3000, createdAt: now - 3000 },
        mockEmbedding
      );

      insertObservation(
        db,
        { title: 'Second', content: 'Second content', project: 'test-project', sessionId: 'session-123', timestamp: now - 2000, createdAt: now - 2000 },
        mockEmbedding
      );

      insertObservation(
        db,
        { title: 'Third', content: 'Third content', project: 'test-project', sessionId: 'session-123', timestamp: now - 1000, createdAt: now - 1000 },
        mockEmbedding
      );

      const config: SessionStartConfig = {
        maxObservations: 20,
        maxTokens: 500,
        recencyDays: 7,
        projectOnly: true,
      };

      const result = await handleSessionStart(db, 'test-project', config);

      // Most recent should appear first
      const lines = result.markdown.split('\n').filter(line => line.startsWith('-'));
      expect(lines[0]).toContain('Third');
      expect(lines[1]).toContain('Second');
      expect(lines[2]).toContain('First');
    });

    test('should handle special characters in content', async () => {
      insertObservation(
        db,
        { title: 'Special chars', content: 'Content with "quotes" and `backticks` and $symbols', project: 'test-project', sessionId: 'session-123', timestamp: Date.now(), createdAt: Date.now() },
        mockEmbedding
      );

      const config: SessionStartConfig = {
        maxObservations: 20,
        maxTokens: 500,
        recencyDays: 7,
        projectOnly: true,
      };

      const result = await handleSessionStart(db, 'test-project', config);

      expect(result.markdown).toContain('Content with "quotes" and `backticks` and $symbols');
    });
  });

  describe('token counting', () => {
    test('should use simple approximation (chars/4)', async () => {
      // Create a simple observation
      const content = 'test content';
      insertObservation(
        db,
        { title: 'Test', content: content, project: 'test-project', sessionId: 'session-123', timestamp: Date.now(), createdAt: Date.now() },
        mockEmbedding
      );

      const config: SessionStartConfig = {
        maxObservations: 20,
        maxTokens: 500,
        recencyDays: 7,
        projectOnly: true,
      };

      const result = await handleSessionStart(db, 'test-project', config);

      // Token count should be approximately length/4 (allow 1 token variance for rounding)
      const expectedTokens = Math.ceil(result.markdown.length / 4);
      expect(result.tokenCount).toBeGreaterThanOrEqual(expectedTokens - 1);
      expect(result.tokenCount).toBeLessThanOrEqual(expectedTokens + 1);
    });
  });
});
