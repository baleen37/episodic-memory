import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from 'bun:sqlite';
import { initDatabase } from './db.js';
import {
  create,
  findById,
  findByIds,
  type ObservationData
} from './observations.js';
import { EMBEDDING_DIM } from './constants.js';

const { mockGenerateEmbedding, mockInitEmbeddings } = vi.hoisted(() => ({
  mockGenerateEmbedding: vi.fn(async () => Array.from({ length: EMBEDDING_DIM }, () => Math.random() * 2 - 1)),
  mockInitEmbeddings: vi.fn(async () => {}),
}));

// Mock generateEmbedding to avoid loading the model in tests
vi.mock('./embeddings.js', () => ({
  generateEmbedding: mockGenerateEmbedding,
  initEmbeddings: mockInitEmbeddings,
}));

describe('observations', () => {
  let db: Database;
  let testDbPath: string;

  beforeEach(() => {
    // Use in-memory database for tests
    testDbPath = ':memory:';
    process.env.CONVERSATION_MEMORY_DB_PATH = testDbPath;
    db = initDatabase();
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('should create an observation with embedding and return id', async () => {
      const id = await create(
        db,
        'Test Observation',
        'This is the content of the observation',
        'test-project',
        'session-123',
        Date.now()
      );

      expect(id).toBeGreaterThan(0);

      // Verify the observation was inserted
      const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as Record<string, unknown>;
      expect(obs).toBeDefined();
      expect(obs.title).toBe('Test Observation');
      expect(obs.content).toBe('This is the content of the observation');
      expect(obs.project).toBe('test-project');
      expect(obs.session_id).toBe('session-123');
    });

    it('should create observation without session_id', async () => {
      const id = await create(
        db,
        'Session-less Observation',
        'Content without session',
        'test-project'
      );

      expect(id).toBeGreaterThan(0);

      const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as Record<string, unknown>;
      expect(obs).toBeDefined();
      expect(obs.session_id).toBeNull();
    });

    it('should generate and store embedding', async () => {
      const id = await create(
        db,
        'Test',
        'Content',
        'test-project'
      );

      // Check vector table
      const vecStmt = db.prepare('SELECT embedding FROM vec_observations WHERE id = ?');
      const vecResult = vecStmt.get(String(id)) as { embedding: Buffer } | undefined;

      expect(vecResult).toBeDefined();
      expect(Buffer.isBuffer(vecResult!.embedding)).toBe(true);
      expect(vecResult!.embedding.length).toBe(EMBEDDING_DIM * 4); // EMBEDDING_DIM floats * 4 bytes
    });

    it('should use provided timestamp', async () => {
      const timestamp = 1234567890000;
      const id = await create(
        db,
        'Test',
        'Content',
        'test-project',
        undefined,
        timestamp
      );

      const obs = db.prepare('SELECT timestamp FROM observations WHERE id = ?').get(id) as Record<string, unknown>;
      expect(obs.timestamp).toBe(timestamp);
    });

    it('should set createdAt to current time when not provided', async () => {
      const beforeCreate = Date.now();
      const id = await create(
        db,
        'Test',
        'Content',
        'test-project'
      );
      const afterCreate = Date.now();

      const obs = db.prepare('SELECT created_at FROM observations WHERE id = ?').get(id) as Record<string, unknown>;
      expect(obs.created_at).toBeGreaterThanOrEqual(beforeCreate);
      expect(obs.created_at).toBeLessThanOrEqual(afterCreate);
    });

    it('should use current time as default timestamp', async () => {
      const beforeCreate = Date.now();
      const id = await create(
        db,
        'Test',
        'Content',
        'test-project'
      );
      const afterCreate = Date.now();

      const obs = db.prepare('SELECT timestamp FROM observations WHERE id = ?').get(id) as Record<string, unknown>;
      expect(obs.timestamp).toBeGreaterThanOrEqual(beforeCreate);
      expect(obs.timestamp).toBeLessThanOrEqual(afterCreate);
    });

    it('should handle multi-byte UTF-8 characters in title and content', async () => {
      const utf8Title = '한글 제목 日本語 タイトル 中文标题';
      const utf8Content = 'Content with emoji 🎉🌍🚀 and special chars: ©®™';

      const id = await create(
        db,
        utf8Title,
        utf8Content,
        'test-project'
      );

      const obs = db.prepare('SELECT title, content FROM observations WHERE id = ?').get(id) as Record<string, unknown>;
      expect(obs.title).toBe(utf8Title);
      expect(obs.content).toBe(utf8Content);
    });

    it('should handle empty content', async () => {
      const id = await create(
        db,
        'Empty Content Test',
        '',
        'test-project'
      );

      const obs = db.prepare('SELECT content FROM observations WHERE id = ?').get(id) as Record<string, unknown>;
      expect(obs.content).toBe('');
    });

    it('should handle long content', async () => {
      const longContent = 'x'.repeat(10000);

      const id = await create(
        db,
        'Long Content Test',
        longContent,
        'test-project'
      );

      const obs = db.prepare('SELECT content FROM observations WHERE id = ?').get(id) as { content: string };
      expect(obs.content).toBe(longContent);
      expect(obs.content.length).toBe(10000);
    });

    it('should handle special characters in project name', async () => {
      const specialProject = 'project-with.special_chars:123';

      const id = await create(
        db,
        'Test',
        'Content',
        specialProject
      );

      const obs = db.prepare('SELECT project FROM observations WHERE id = ?').get(id) as Record<string, unknown>;
      expect(obs.project).toBe(specialProject);
    });

    it('should handle newlines and tabs in content', async () => {
      const contentWithSpecialChars = 'Line 1\nLine 2\tTabbed\r\nWindows line ending';

      const id = await create(
        db,
        'Special Chars Test',
        contentWithSpecialChars,
        'test-project'
      );

      const obs = db.prepare('SELECT content FROM observations WHERE id = ?').get(id) as Record<string, unknown>;
      expect(obs.content).toBe(contentWithSpecialChars);
    });

    it('should return incremental ids', async () => {
      const id1 = await create(db, 'Obs 1', 'Content 1', 'test-project');
      const id2 = await create(db, 'Obs 2', 'Content 2', 'test-project');
      const id3 = await create(db, 'Obs 3', 'Content 3', 'test-project');

      expect(id2).toBeGreaterThan(id1);
      expect(id3).toBeGreaterThan(id2);
    });

    it('should persist optional contentOriginal', async () => {
      const id = await create(
        db,
        'Bilingual observation',
        'English canonical summary',
        'test-project',
        'session-123',
        Date.now(),
        '원문 요약 텍스트'
      );

      const obs = db.prepare('SELECT content_original FROM observations WHERE id = ?').get(id) as { content_original: string | null };
      expect(obs.content_original).toBe('원문 요약 텍스트');
    });

    it('should keep embedding source as title + content only', async () => {
      await create(
        db,
        'Embedding title',
        'English canonical summary',
        'test-project',
        'session-123',
        Date.now(),
        '원문 텍스트'
      );

      expect(mockGenerateEmbedding).toHaveBeenCalledWith('Embedding title\nEnglish canonical summary');
    });
  });

  describe('findById', () => {
    it('should retrieve observation by id', async () => {
      const id = await create(
        db,
        'Find Me',
        'Find my content',
        'test-project'
      );

      const observation = await findById(db, id);

      expect(observation).toBeDefined();
      expect(observation!.id).toBe(id);
      expect(observation!.title).toBe('Find Me');
      expect(observation!.content).toBe('Find my content');
      expect(observation!.contentOriginal).toBeNull();
      expect(observation!.project).toBe('test-project');
    });

    it('should return null for non-existent id', async () => {
      const observation = await findById(db, 99999);
      expect(observation).toBeNull();
    });

    it('should return all required fields', async () => {
      const timestamp = Date.now();
      const id = await create(
        db,
        'Full Observation',
        'Full content',
        'test-project',
        'session-456',
        timestamp
      );

      const observation = await findById(db, id);

      expect(observation).not.toBeNull();
      expect(observation!.id).toBe(id);
      expect(observation!.title).toBe('Full Observation');
      expect(observation!.content).toBe('Full content');
      expect(observation!.project).toBe('test-project');
      expect(observation!.sessionId).toBe('session-456');
      expect(observation!.timestamp).toBe(timestamp);
    });

    it('should return null sessionId when not provided', async () => {
      const id = await create(
        db,
        'No Session',
        'Content',
        'test-project'
      );

      const observation = await findById(db, id);

      expect(observation).not.toBeNull();
      expect(observation!.sessionId).toBeNull();
    });

    it('should return contentOriginal when provided', async () => {
      const id = await create(
        db,
        'Has original text',
        'English canonical summary',
        'test-project',
        'session-123',
        Date.now(),
        '원문 텍스트'
      );

      const observation = await findById(db, id);

      expect(observation).not.toBeNull();
      expect(observation!.contentOriginal).toBe('원문 텍스트');
    });

    it('should return observation for id 1', async () => {
      const id = await create(db, 'First', 'Content', 'project');
      expect(id).toBe(1);

      const observation = await findById(db, 1);
      expect(observation).not.toBeNull();
      expect(observation!.id).toBe(1);
    });
  });

  describe('findByIds', () => {
    it('should retrieve multiple observations by ids', async () => {
      const now = Date.now();
      const id1 = await create(db, 'Obs 1', 'Content 1', 'test-project', undefined, now - 200);
      await create(db, 'Obs 2', 'Content 2', 'test-project', undefined, now - 100);
      const id3 = await create(db, 'Obs 3', 'Content 3', 'test-project', undefined, now);

      const observations = await findByIds(db, [id1, id3]);

      expect(observations).toHaveLength(2);
      // Results are ordered by timestamp DESC, so id3 (newest timestamp) comes first
      expect(observations[0].title).toBe('Obs 3');
      expect(observations[1].title).toBe('Obs 1');
    });

    it('should return empty array for empty ids', async () => {
      const observations = await findByIds(db, []);
      expect(observations).toHaveLength(0);
    });

    it('should return empty array for non-existent ids', async () => {
      const observations = await findByIds(db, [99998, 99999]);
      expect(observations).toHaveLength(0);
    });

    it('should return only existing observations when some ids do not exist', async () => {
      const id1 = await create(db, 'Obs 1', 'Content 1', 'test-project');
      const id2 = await create(db, 'Obs 2', 'Content 2', 'test-project');

      const observations = await findByIds(db, [id1, 99999, id2]);

      expect(observations).toHaveLength(2);
      const titles = observations.map(o => o.title);
      expect(titles).toContain('Obs 1');
      expect(titles).toContain('Obs 2');
    });

    it('should handle single id', async () => {
      const id = await create(db, 'Single', 'Content', 'test-project');

      const observations = await findByIds(db, [id]);

      expect(observations).toHaveLength(1);
      expect(observations[0].title).toBe('Single');
    });

    it('should return all required fields for each observation', async () => {
      const id = await create(db, 'Full Test', 'Content', 'project', 'session-1');

      const observations = await findByIds(db, [id]);

      expect(observations).toHaveLength(1);
      const obs = observations[0];
      expect(obs.id).toBe(id);
      expect(obs.title).toBe('Full Test');
      expect(obs.content).toBe('Content');
      expect(obs.contentOriginal).toBeNull();
      expect(obs.project).toBe('project');
      expect(obs.sessionId).toBe('session-1');
      expect(typeof obs.timestamp).toBe('number');
    });

    it('should maintain order by timestamp descending', async () => {
      const now = Date.now();
      const id1 = await create(db, 'Oldest', 'Content', 'project', undefined, now - 1000);
      const id2 = await create(db, 'Middle', 'Content', 'project', undefined, now - 500);
      const id3 = await create(db, 'Newest', 'Content', 'project', undefined, now);

      const observations = await findByIds(db, [id1, id2, id3]);

      expect(observations).toHaveLength(3);
      expect(observations[0].title).toBe('Newest');
      expect(observations[1].title).toBe('Middle');
      expect(observations[2].title).toBe('Oldest');
    });

    it('should handle many ids efficiently', async () => {
      const ids: number[] = [];
      const now = Date.now();

      for (let i = 0; i < 50; i++) {
        const id = await create(db, `Obs ${i}`, `Content ${i}`, 'project', undefined, now + i);
        ids.push(id);
      }

      const observations = await findByIds(db, ids);

      expect(observations).toHaveLength(50);
    });

    it('should return empty array when no ids match', async () => {
      await create(db, 'Existing', 'Content', 'project');

      const observations = await findByIds(db, [99990, 99991, 99992]);

      expect(observations).toHaveLength(0);
    });
  });

  describe('Observation type', () => {
    it('should match expected interface structure', async () => {
      const timestamp = Date.now();
      const id = await create(
        db,
        'Type Test',
        'Content',
        'project',
        'session-1',
        timestamp
      );

      const observation = await findById(db, id);

      // Verify all expected properties exist with correct types
      expect(observation).not.toBeNull();
      const obs: ObservationData = observation!;

      expect(typeof obs.id).toBe('number');
      expect(typeof obs.title).toBe('string');
      expect(typeof obs.content).toBe('string');
      expect(obs.contentOriginal === null || typeof obs.contentOriginal === 'string').toBe(true);
      expect(typeof obs.project).toBe('string');
      // sessionId can be string or null
      expect(obs.sessionId === null || typeof obs.sessionId === 'string').toBe(true);
      expect(typeof obs.timestamp).toBe('number');
    });
  });
});
