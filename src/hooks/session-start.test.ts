/**
 * Tests for SessionStart hook - token-budgeted injection of recent observations.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase, insertObservation } from '../core/db.js';
import { handleSessionStart, type SessionStartConfig } from './session-start.js';
import { EMBEDDING_DIM } from '../core/constants.js';

// Real embedding array for insertObservation calls
const mockEmbedding = new Array(EMBEDDING_DIM).fill(0.1);

describe('SessionStart Hook', () => {
  let db: Database;

  beforeEach(() => {
    process.env.CONVERSATION_MEMORY_DB_PATH = ':memory:';
    db = initDatabase();
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

    test('should filter by project when projectOnly is true', async () => {
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

      insertObservation(
        db,
        { title: 'Old obs', content: 'Old content', project: 'test-project', sessionId: 'session-123', timestamp: now - 10 * dayInMs, createdAt: now - 10 * dayInMs },
        mockEmbedding
      );

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

    test('should return results ordered by recency', async () => {
      const now = Date.now();

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

      const lines = result.markdown.split('\n').filter(line => line.startsWith('-'));
      expect(lines[0]).toContain('Third');
      expect(lines[1]).toContain('Second');
      expect(lines[2]).toContain('First');
    });
  });
});
