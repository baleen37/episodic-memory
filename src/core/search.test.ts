/**
 * Tests for observation search
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase, insertObservation } from './db.js';
import { search } from './search.js';
import { EMBEDDING_DIM } from './constants.js';
import { __setModelForTests } from './embeddings.js';
import { resetRateLimiters, __setLoadConfigForTests } from './ratelimiter.js';

// Global mock factory that can be controlled per test
let mockGenerateEmbedding: (() => Promise<number[]>) | null = null;

describe('search - observation search', () => {
  let db: Database;

  beforeEach(() => {
    process.env.CONVERSATION_MEMORY_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(
      async () => {},
      async () => mockGenerateEmbedding?.() ?? [],
    );
    __setLoadConfigForTests(() => ({
      provider: 'gemini', apiKey: 'test',
      ratelimit: { embedding: { requestsPerSecond: 100, burstSize: 100 } },
    }) as any);
    resetRateLimiters();
  });

  afterEach(() => {
    db.close();
    mockGenerateEmbedding = null;
    __setModelForTests(null, null);
    __setLoadConfigForTests(null);
    resetRateLimiters();
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

  describe('validateISODate (via search)', () => {
    test('should accept valid ISO date format', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding();

      await expect(
        search('test query', { db, after: '2025-01-15', before: '2025-01-20' })
      ).resolves.toEqual([]);
    });

    test('should reject invalid date format', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding();

      await expect(
        search('test query', { db, after: '2025/01/15' })
      ).rejects.toThrow('Invalid --after date');
    });

    test('should reject invalid calendar date', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding();

      await expect(
        search('test query', { db, after: '2025-02-30' })
      ).rejects.toThrow('Not a valid calendar date');
    });

    test('should accept leap year date', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding();

      await expect(
        search('test query', { db, after: '2024-02-29' })
      ).resolves.toEqual([]);
    });
  });

  describe('search - vector mode', () => {
    beforeEach(() => {
      const now = Date.now();

      // Insert test observations with embeddings
      insertTestObservation(db, {
        title: 'Authentication system',
        content: 'Implement JWT-based authentication with refresh tokens',
        project: 'test-project',
        sessionId: 'session-1',
        timestamp: now - 2000
      }, createTestEmbedding(1));

      insertTestObservation(db, {
        title: 'Database optimization',
        content: 'Added indexes to improve query performance',
        project: 'test-project',
        sessionId: 'session-2',
        timestamp: now - 1000
      }, createTestEmbedding(2));

      insertTestObservation(db, {
        title: 'Testing improvements',
        content: 'Added unit tests for core modules',
        project: 'test-project',
        sessionId: 'session-3',
        timestamp: now
      }, createTestEmbedding(3));
    });

    test('should perform vector similarity search', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding(1); // Similar to first observation

      const results = await search('authentication', { db });

      expect(results.length).toBeGreaterThan(0);
    });

    test('should respect limit', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding(1);

      const results = await search('test', { db, limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    test('should filter by project', async () => {
      const now = Date.now();

      insertTestObservation(db, {
        title: 'Project A observation',
        content: 'Content for project A',
        project: 'project-a',
        timestamp: now + 1000
      }, createTestEmbedding(5));

      mockGenerateEmbedding = async () => createTestEmbedding(5);

      const results = await search('project', { db, projects: ['project-a'] });
      expect(results.every(r => r.project === 'project-a')).toBe(true);
    });

    test('should filter by date range', async () => {
      const oldDate = new Date('2025-01-10').getTime();
      const newDate = new Date('2025-01-20').getTime();

      insertTestObservation(db, {
        title: 'Old observation',
        content: 'Old content',
        project: 'test-project',
        timestamp: oldDate
      }, createTestEmbedding(10));

      insertTestObservation(db, {
        title: 'New observation',
        content: 'New content',
        project: 'test-project',
        timestamp: newDate
      }, createTestEmbedding(11));

      mockGenerateEmbedding = async () => createTestEmbedding(11);

      const results = await search('content', {
        db,
        after: '2025-01-15',
        before: '2025-01-25'
      });

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('New observation');
    });
  });

  describe('search - hybrid mode', () => {
    test('should fill remaining slots with keyword search when vector results are insufficient', async () => {
      const now = Date.now();

      insertTestObservation(db, {
        title: 'Vector-backed observation',
        content: 'hybrid token from vector and keyword',
        project: 'test-project',
        timestamp: now - 2000
      }, createTestEmbedding(1));

      insertTestObservation(db, {
        title: 'Keyword-only observation 1',
        content: 'hybrid token in content only',
        project: 'test-project',
        timestamp: now - 1000
      });

      insertTestObservation(db, {
        title: 'Keyword-only observation 2',
        content: 'another hybrid token entry',
        project: 'test-project',
        timestamp: now
      });

      mockGenerateEmbedding = async () => createTestEmbedding(1);

      const results = await search('hybrid token', { db, limit: 3 });

      expect(results).toHaveLength(3);
      expect(results[0].title).toBe('Vector-backed observation');
      expect(results.slice(1).map(r => r.title)).toEqual([
        'Keyword-only observation 2',
        'Keyword-only observation 1'
      ]);
    });

    test('should dedupe duplicate ids across vector and keyword strategies', async () => {
      const now = Date.now();

      insertTestObservation(db, {
        title: 'Vector and keyword match',
        content: 'dedupe token appears here',
        project: 'test-project',
        timestamp: now - 1000
      }, createTestEmbedding(1));

      insertTestObservation(db, {
        title: 'Keyword only unique',
        content: 'dedupe token appears only in keyword strategy',
        project: 'test-project',
        timestamp: now
      });

      mockGenerateEmbedding = async () => createTestEmbedding(1);

      const results = await search('dedupe token', { db, limit: 2 });

      expect(results).toHaveLength(2);
      expect(results[0].title).toBe('Vector and keyword match');
      expect(results[1].title).toBe('Keyword only unique');
      expect(new Set(results.map(r => r.id)).size).toBe(2);
    });

    test('should fill remaining slots when top keyword hits overlap vector results', async () => {
      const now = Date.now();

      insertTestObservation(db, {
        title: 'Vector and keyword top hit',
        content: 'overlap token in vector and keyword',
        project: 'test-project',
        timestamp: now
      }, createTestEmbedding(1));

      insertTestObservation(db, {
        title: 'Keyword unique recent',
        content: 'overlap token unique content 1',
        project: 'test-project',
        timestamp: now - 1000
      });

      insertTestObservation(db, {
        title: 'Keyword unique older',
        content: 'overlap token unique content 2',
        project: 'test-project',
        timestamp: now - 2000
      });

      mockGenerateEmbedding = async () => createTestEmbedding(1);

      const results = await search('overlap token', { db, limit: 3 });

      expect(results).toHaveLength(3);
      expect(results.map(r => r.title)).toEqual([
        'Vector and keyword top hit',
        'Keyword unique recent',
        'Keyword unique older'
      ]);
    });

    test('should search keywords in observations.content only', async () => {
      const now = Date.now();

      insertTestObservation(db, {
        title: 'keyword-only-title-hit',
        content: 'content without query term',
        project: 'test-project',
        timestamp: now - 1000
      });

      insertTestObservation(db, {
        title: 'non-matching title',
        content: 'content includes keyword-only-title-hit token',
        project: 'test-project',
        timestamp: now
      });

      mockGenerateEmbedding = async () => createTestEmbedding(999);

      const results = await search('keyword-only-title-hit', { db, limit: 5 });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('non-matching title');
    });

    test('should apply filters to keyword fallback results', async () => {
      insertTestObservation(db, {
        title: 'Keyword filtered in',
        content: 'fallback filter token in src/target.ts',
        project: 'project-a',
        timestamp: new Date('2025-01-20').getTime()
      });

      insertTestObservation(db, {
        title: 'Keyword wrong project',
        content: 'fallback filter token in src/target.ts',
        project: 'project-b',
        timestamp: new Date('2025-01-20').getTime()
      });

      insertTestObservation(db, {
        title: 'Keyword wrong file',
        content: 'fallback filter token in src/other.ts',
        project: 'project-a',
        timestamp: new Date('2025-01-20').getTime()
      });

      insertTestObservation(db, {
        title: 'Keyword wrong date',
        content: 'fallback filter token in src/target.ts',
        project: 'project-a',
        timestamp: new Date('2025-01-10').getTime()
      });

      mockGenerateEmbedding = async () => createTestEmbedding(999);

      const results = await search('fallback filter token', {
        db,
        limit: 5,
        projects: ['project-a'],
        files: ['src/target.ts'],
        after: '2025-01-15'
      });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Keyword filtered in');
    });
  });

  describe('search - query normalization', () => {
    test('should use normalized English query when queryNormalizerProvider is provided', async () => {
      insertTestObservation(db, {
        title: 'Auth fix',
        content: 'fixed authentication issue in login flow',
        project: 'test-project',
        timestamp: Date.now()
      });

      mockGenerateEmbedding = async () => createTestEmbedding(999);

      const queryNormalizerProvider = {
        complete: mock(async () => ({
          text: 'authentication issue',
          usage: { input_tokens: 10, output_tokens: 3 }
        }))
      };

      const results = await search('인증 이슈', {
        db,
        limit: 5,
        queryNormalizerProvider: queryNormalizerProvider as any
      } as any);

      expect(queryNormalizerProvider.complete).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Auth fix');
    });

    test('should fallback to original query when normalization fails', async () => {
      insertTestObservation(db, {
        title: 'Korean observation',
        content: '인증 이슈 해결 완료',
        project: 'test-project',
        timestamp: Date.now()
      });

      mockGenerateEmbedding = async () => createTestEmbedding(999);

      const queryNormalizerProvider = {
        complete: mock(async () => { throw new Error('normalization failed'); })
      };

      const results = await search('인증 이슈', {
        db,
        limit: 5,
        queryNormalizerProvider: queryNormalizerProvider as any
      } as any);

      expect(queryNormalizerProvider.complete).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Korean observation');
    });
  });

  describe('search - result structure', () => {
    beforeEach(() => {
      insertTestObservation(db, {
        title: 'Test Result',
        content: 'Test content for result structure',
        project: 'test-project',
        sessionId: 'test-session',
        timestamp: Date.now()
      }, createTestEmbedding(1));
    });

    test('should return compact observations without internal or heavy fields', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding(1);

      const results = await search('test', { db });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toMatchObject({
        id: expect.any(Number),
        title: 'Test Result',
        project: 'test-project',
        timestamp: expect.any(Number)
      });
      expect(results[0]).not.toHaveProperty('content');
      expect(results[0]).not.toHaveProperty('sessionId');
      expect(results[0]).not.toHaveProperty('similarity');
      expect(results[0]).not.toHaveProperty('distance');
    });
  });

  describe('search - edge cases', () => {
    test('should handle empty database', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding();

      const results = await search('test', { db });
      expect(results).toEqual([]);
    });

    test('should handle unicode and special characters in query/content', async () => {
      insertTestObservation(db, {
        title: 'Unicode test',
        content: 'Test with special characters: @#$%^&*() and unicode: Hello 世界 🌍',
        project: 'test-project',
        timestamp: Date.now()
      }, createTestEmbedding(1));

      mockGenerateEmbedding = async () => createTestEmbedding(1);

      const results = await search('unicode', { db });
      expect(results.length).toBeGreaterThan(0);
    });

    test('should handle very long queries', async () => {
      const longQuery = 'a'.repeat(1000);

      mockGenerateEmbedding = async () => createTestEmbedding();

      await expect(search(longQuery, { db })).resolves.toEqual([]);
    });
  });

  describe('search - files filter', () => {
    beforeEach(() => {
      const now = Date.now();

      insertTestObservation(db, {
        title: 'File A implementation',
        content: 'Implemented feature in src/file-a.ts',
        project: 'test-project',
        timestamp: now - 2000
      }, createTestEmbedding(1));

      insertTestObservation(db, {
        title: 'File B implementation',
        content: 'Fixed bug in lib/file-b.ts',
        project: 'test-project',
        timestamp: now - 1000
      }, createTestEmbedding(2));

      insertTestObservation(db, {
        title: 'No files mentioned',
        content: 'General architectural decision without files',
        project: 'test-project',
        timestamp: now
      }, createTestEmbedding(3));
    });

    test('should filter by single file path', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding();

      const results = await search('implementation', { db, files: ['src/file-a.ts'] });
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('File A implementation');
    });

    test('should filter by multiple file paths', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding();

      const results = await search('implementation', { db, files: ['src/file-a.ts', 'lib/file-b.ts'] });
      expect(results.length).toBe(2);
      const titles = results.map(r => r.title);
      expect(titles).toContain('File A implementation');
      expect(titles).toContain('File B implementation');
    });

    test('should return empty when no matching files', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding();

      const results = await search('implementation', { db, files: ['nonexistent/file.ts'] });
      expect(results.length).toBe(0);
    });

    test('should handle empty files array', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding();

      const results = await search('implementation', { db, files: [] });
      expect(results.length).toBe(3);
    });

    test('should handle partial file path matches', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding();

      const results = await search('implementation', { db, files: ['file-a'] });
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('File A implementation');
    });
  });

  describe('search - date filters', () => {
    test('should filter with only after date', async () => {
      const oldDate = new Date('2025-01-10').getTime();
      const newDate = new Date('2025-01-20').getTime();

      insertTestObservation(db, {
        title: 'Old observation',
        content: 'Old content',
        project: 'test-project',
        timestamp: oldDate
      }, createTestEmbedding(1));

      insertTestObservation(db, {
        title: 'New observation',
        content: 'New content',
        project: 'test-project',
        timestamp: newDate
      }, createTestEmbedding(2));

      mockGenerateEmbedding = async () => createTestEmbedding();

      const results = await search('content', { db, after: '2025-01-15' });

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('New observation');
    });

    test('should filter with only before date', async () => {
      const oldDate = new Date('2025-01-10').getTime();
      const newDate = new Date('2025-01-20').getTime();

      insertTestObservation(db, {
        title: 'Old observation',
        content: 'Old content',
        project: 'test-project',
        timestamp: oldDate
      }, createTestEmbedding(1));

      insertTestObservation(db, {
        title: 'New observation',
        content: 'New content',
        project: 'test-project',
        timestamp: newDate
      }, createTestEmbedding(2));

      mockGenerateEmbedding = async () => createTestEmbedding();

      const results = await search('content', { db, before: '2025-01-15' });

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Old observation');
    });

    test('should include boundary dates (inclusive)', async () => {
      const boundaryDate = new Date('2025-01-15').getTime();

      insertTestObservation(db, {
        title: 'Boundary observation',
        content: 'Boundary content',
        project: 'test-project',
        timestamp: boundaryDate
      }, createTestEmbedding(1));

      mockGenerateEmbedding = async () => createTestEmbedding(1);

      const results = await search('Boundary', {
        db,
        after: '2025-01-15',
        before: '2025-01-15'
      });

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Boundary observation');
    });

    test('should include observations later on the before date', async () => {
      const sameDayNoon = Date.UTC(2025, 0, 15, 12, 34, 56);

      insertTestObservation(db, {
        title: 'Noon observation',
        content: 'Noon marker content',
        project: 'test-project',
        timestamp: sameDayNoon
      });

      mockGenerateEmbedding = async () => createTestEmbedding(1);

      const results = await search('Noon marker', {
        db,
        before: '2025-01-15'
      });

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Noon observation');
    });
  });

  describe('search - multiple project filter', () => {
    beforeEach(() => {
      const now = Date.now();

      insertTestObservation(db, {
        title: 'Project A task',
        content: 'Task for project A',
        project: 'project-a',
        timestamp: now - 2000
      }, createTestEmbedding(1));

      insertTestObservation(db, {
        title: 'Project B task',
        content: 'Task for project B',
        project: 'project-b',
        timestamp: now - 1000
      }, createTestEmbedding(2));

      insertTestObservation(db, {
        title: 'Project C task',
        content: 'Task for project C',
        project: 'project-c',
        timestamp: now
      }, createTestEmbedding(3));
    });

    test('should filter by multiple projects', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding();

      const results = await search('task', { db, projects: ['project-a', 'project-c'] });

      expect(results.length).toBe(2);
      const projects = results.map(r => r.project);
      expect(projects).toContain('project-a');
      expect(projects).toContain('project-c');
      expect(projects).not.toContain('project-b');
    });

    test('should return empty when no matching projects', async () => {
      mockGenerateEmbedding = async () => createTestEmbedding();

      const results = await search('task', { db, projects: ['nonexistent-project'] });
      expect(results.length).toBe(0);
    });
  });

  describe('search - limit behavior', () => {
    test('should use default limit of 10', async () => {
      // Insert 15 observations
      for (let i = 0; i < 15; i++) {
        insertTestObservation(db, {
          title: `Observation ${i}`,
          content: `Content ${i}`,
          project: 'test-project',
          timestamp: Date.now() + i
        }, createTestEmbedding(i));
      }

      mockGenerateEmbedding = async () => createTestEmbedding();

      const results = await search('Content', { db });
      expect(results.length).toBe(10);
    });

    test('should return fewer results when not enough matches', async () => {
      insertTestObservation(db, {
        title: 'Single observation',
        content: 'Single content',
        project: 'test-project',
        timestamp: Date.now()
      }, createTestEmbedding(1));

      mockGenerateEmbedding = async () => createTestEmbedding(1);

      const results = await search('Single', { db, limit: 10 });
      expect(results.length).toBe(1);
    });
  });

  describe('search - ordering', () => {
    test('should order results by vector distance (most similar first)', async () => {
      const now = Date.now();

      // Insert observations with different embeddings
      insertTestObservation(db, {
        title: 'Similar observation',
        content: 'Very similar content',
        project: 'test-project',
        timestamp: now - 2000
      }, createTestEmbedding(1));

      insertTestObservation(db, {
        title: 'Less similar observation',
        content: 'Less similar content',
        project: 'test-project',
        timestamp: now
      }, createTestEmbedding(100));

      // Use embedding similar to first observation
      mockGenerateEmbedding = async () => createTestEmbedding(1);

      const results = await search('similar', { db, limit: 2 });

      // First result should be the most similar one (embedding seed 1)
      expect(results[0].title).toBe('Similar observation');
    });
  });

  describe('search - combined filters', () => {
    test('should combine projects and date filters', async () => {
      insertTestObservation(db, {
        title: 'Old Project A',
        content: 'Content old project A',
        project: 'project-a',
        timestamp: new Date('2025-01-10').getTime()
      }, createTestEmbedding(1));

      insertTestObservation(db, {
        title: 'New Project A',
        content: 'Content new project A',
        project: 'project-a',
        timestamp: new Date('2025-01-20').getTime()
      }, createTestEmbedding(2));

      insertTestObservation(db, {
        title: 'New Project B',
        content: 'Content new project B',
        project: 'project-b',
        timestamp: new Date('2025-01-20').getTime()
      }, createTestEmbedding(3));

      mockGenerateEmbedding = async () => createTestEmbedding();

      const results = await search('Content', {
        db,
        projects: ['project-a'],
        after: '2025-01-15'
      });

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('New Project A');
    });

    test('should combine files and projects filters', async () => {
      insertTestObservation(db, {
        title: 'Project A file',
        content: 'Modified src/file.ts in project A',
        project: 'project-a',
        timestamp: Date.now()
      }, createTestEmbedding(1));

      insertTestObservation(db, {
        title: 'Project B file',
        content: 'Modified src/file.ts in project B',
        project: 'project-b',
        timestamp: Date.now()
      }, createTestEmbedding(2));

      mockGenerateEmbedding = async () => createTestEmbedding();

      const results = await search('Modified', {
        db,
        projects: ['project-a'],
        files: ['src/file.ts']
      });

      expect(results.length).toBe(1);
      expect(results[0].project).toBe('project-a');
    });

    test('should combine all filters together', async () => {
      insertTestObservation(db, {
        title: 'Match all filters',
        content: 'Modified src/app.ts',
        project: 'project-a',
        timestamp: new Date('2025-01-20').getTime()
      }, createTestEmbedding(1));

      insertTestObservation(db, {
        title: 'Wrong project',
        content: 'Modified src/app.ts',
        project: 'project-b',
        timestamp: new Date('2025-01-20').getTime()
      }, createTestEmbedding(2));

      insertTestObservation(db, {
        title: 'Wrong file',
        content: 'Modified lib/util.ts',
        project: 'project-a',
        timestamp: new Date('2025-01-20').getTime()
      }, createTestEmbedding(3));

      insertTestObservation(db, {
        title: 'Wrong date',
        content: 'Modified src/app.ts',
        project: 'project-a',
        timestamp: new Date('2025-01-10').getTime()
      }, createTestEmbedding(4));

      mockGenerateEmbedding = async () => createTestEmbedding();

      const results = await search('Modified', {
        db,
        projects: ['project-a'],
        files: ['src/app.ts'],
        after: '2025-01-15',
        limit: 5
      });

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Match all filters');
    });
  });

  describe('search - isoToTimestamp (via date filters)', () => {
    test('should correctly convert ISO date to timestamp', async () => {
      const specificDate = new Date('2025-06-15').getTime();

      insertTestObservation(db, {
        title: 'June observation',
        content: 'June content',
        project: 'test-project',
        timestamp: specificDate
      }, createTestEmbedding(1));

      mockGenerateEmbedding = async () => createTestEmbedding(1);

      // Query with the exact date should include this observation
      const results = await search('June', {
        db,
        after: '2025-06-15',
        before: '2025-06-15'
      });

      expect(results.length).toBe(1);
    });
  });
});
