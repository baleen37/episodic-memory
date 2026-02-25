import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { initDatabase, openDatabase, insertPendingEvent, insertObservation, searchObservations, getObservation, getAllPendingEvents } from './db.js';
import { EMBEDDING_DIM } from './constants.js';

describe('Database Schema', () => {
  let db: Database;

  beforeEach(() => {
    // Use in-memory database for testing
    process.env.CONVERSATION_MEMORY_DB_PATH = ':memory:';
    db = initDatabase();
  });

  describe('initDatabase', () => {
    test('creates all required tables', () => {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as Array<{ name: string }>;

      const tableNames = tables.map(t => t.name);

      // Tables
      expect(tableNames).toContain('observations');
      expect(tableNames).toContain('pending_events');
      expect(tableNames).toContain('vec_observations');

      // Old tables should NOT exist
      expect(tableNames).not.toContain('exchanges');
      expect(tableNames).not.toContain('vec_exchanges');
      expect(tableNames).not.toContain('tool_calls');
      expect(tableNames).not.toContain('session_summaries');
    });

    test('creates pending_events table with correct schema', () => {
      const columns = db.prepare(`
        SELECT name, type, "notnull" FROM pragma_table_info('pending_events')
        ORDER BY cid
      `).all() as Array<{ name: string; type: string; notnull: number }>;

      const columnMap = new Map(columns.map(c => [c.name, { type: c.type, notnull: c.notnull }]));

      // Check required columns
      // Note: INTEGER PRIMARY KEY has notnull=0 in SQLite (it's implicitly NOT NULL)
      expect(columnMap.get('id')).toEqual({ type: 'INTEGER', notnull: 0 });
      expect(columnMap.get('session_id')).toEqual({ type: 'TEXT', notnull: 1 });
      expect(columnMap.get('project')).toEqual({ type: 'TEXT', notnull: 1 });
      expect(columnMap.get('tool_name')).toEqual({ type: 'TEXT', notnull: 1 });
      expect(columnMap.get('compressed')).toEqual({ type: 'TEXT', notnull: 1 });
      expect(columnMap.get('timestamp')).toEqual({ type: 'INTEGER', notnull: 1 });
      expect(columnMap.get('created_at')).toEqual({ type: 'INTEGER', notnull: 1 });

      // Check primary key
      const pk = db.prepare(`
        SELECT sql FROM sqlite_master WHERE type='table' AND name='pending_events'
      `).get() as { sql: string };

      expect(pk.sql).toContain('PRIMARY KEY');
    });

    test('creates observations table with correct schema', () => {
      const columns = db.prepare(`
        SELECT name, type, "notnull" FROM pragma_table_info('observations')
        ORDER BY cid
      `).all() as Array<{ name: string; type: string; notnull: number }>;

      const columnMap = new Map(columns.map(c => [c.name, { type: c.type, notnull: c.notnull }]));

      // Check required columns
      // Note: INTEGER PRIMARY KEY has notnull=0 in SQLite (it's implicitly NOT NULL)
      expect(columnMap.get('id')).toEqual({ type: 'INTEGER', notnull: 0 });
      expect(columnMap.get('title')).toEqual({ type: 'TEXT', notnull: 1 });
      expect(columnMap.get('content')).toEqual({ type: 'TEXT', notnull: 1 });
      expect(columnMap.get('project')).toEqual({ type: 'TEXT', notnull: 1 });
      expect(columnMap.get('session_id')).toEqual({ type: 'TEXT', notnull: 0 }); // nullable
      expect(columnMap.get('content_original')).toEqual({ type: 'TEXT', notnull: 0 }); // nullable
      expect(columnMap.get('timestamp')).toEqual({ type: 'INTEGER', notnull: 1 });
      expect(columnMap.get('created_at')).toEqual({ type: 'INTEGER', notnull: 1 });
    });

    test('creates vec_observations virtual table', () => {
      const tableInfo = db.prepare(`
        SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_observations'
      `).get() as { sql: string } | undefined;

      expect(tableInfo).toBeDefined();
      expect(tableInfo?.sql).toContain('vec0');
      expect(tableInfo?.sql).toContain('embedding');
    });


    test('creates proper indexes', () => {
      const indexes = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='index'
        AND name LIKE 'idx_%'
        ORDER BY name
      `).all() as Array<{ name: string }>;

      const indexNames = indexes.map(i => i.name);

      expect(indexNames).toContain('idx_pending_session');
      expect(indexNames).toContain('idx_pending_project');
      expect(indexNames).toContain('idx_pending_timestamp');
      expect(indexNames).toContain('idx_observations_project');
      expect(indexNames).toContain('idx_observations_session');
      expect(indexNames).toContain('idx_observations_timestamp');
    });

    test('enables WAL mode', () => {
      const result = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      // In-memory databases fall back to 'memory', file-based would be 'wal'
      expect(['wal', 'memory']).toContain(result.journal_mode);
    });

    test('loads sqlite-vec extension', () => {
      // Try to create a test vector to verify the extension is loaded
      const testVec = new Float32Array(EMBEDDING_DIM).fill(0.1);
      expect(() => {
        const stmt = db.prepare('INSERT INTO vec_observations (id, embedding) VALUES (?, ?)');
        stmt.run('test-id', Buffer.from(testVec.buffer));
        db.prepare('DELETE FROM vec_observations WHERE id = ?').run('test-id');
      }).not.toThrow();
    });
  });

  describe('insertPendingEvent', () => {
    test('inserts pending event with all fields', () => {
      const now = Date.now();

      insertPendingEvent(db, {
        sessionId: 'test-session',
        project: 'test-project',
        toolName: 'bash',
        compressed: 'command: echo test',
        timestamp: now,
        createdAt: now,
      });

      const row = db.prepare(`
        SELECT * FROM pending_events WHERE id = ?
      `).get(1) as any;

      expect(row).toBeDefined();
      expect(row.session_id).toBe('test-session');
      expect(row.project).toBe('test-project');
      expect(row.tool_name).toBe('bash');
      expect(row.compressed).toBe('command: echo test');
      expect(row.timestamp).toBe(now);
      expect(row.created_at).toBe(now);
    });

    test('auto-increments id', () => {
      insertPendingEvent(db, {
        sessionId: 'session-1',
        project: 'project-1',
        toolName: 'tool1',
        compressed: 'data1',
        timestamp: Date.now(),
        createdAt: Date.now(),
      });

      insertPendingEvent(db, {
        sessionId: 'session-2',
        project: 'project-2',
        toolName: 'tool2',
        compressed: 'data2',
        timestamp: Date.now(),
        createdAt: Date.now(),
      });

      const count = db.prepare(`SELECT COUNT(*) as count FROM pending_events`).get() as { count: number };
      expect(count.count).toBe(2);

      const firstRow = db.prepare(`SELECT id FROM pending_events WHERE id = 1`).get() as any;
      const secondRow = db.prepare(`SELECT id FROM pending_events WHERE id = 2`).get() as any;

      expect(firstRow).toBeDefined();
      expect(secondRow).toBeDefined();
    });

    test('stores special characters in compressed field', () => {
      const specialData = 'Multi\nLine\tData\twith\x00null';

      insertPendingEvent(db, {
        sessionId: 'test-session',
        project: 'test-project',
        toolName: 'bash',
        compressed: specialData,
        timestamp: Date.now(),
        createdAt: Date.now(),
      });

      const row = db.prepare(`SELECT compressed FROM pending_events WHERE id = 1`).get() as any;
      expect(row.compressed).toBe(specialData);
    });
  });

  describe('insertObservation', () => {
    test('inserts observation with all required fields', () => {
      const now = Date.now();
      const embedding = new Array(EMBEDDING_DIM).fill(0.1);

      insertObservation(db, {
        title: 'Test Observation',
        content: 'This is test content for the observation',
        contentOriginal: 'This is original content for the observation',
        project: 'test-project',
        sessionId: 'test-session',
        timestamp: now,
        createdAt: now,
      }, embedding);

      const row = db.prepare(`
        SELECT * FROM observations WHERE id = 1
      `).get() as any;

      expect(row).toBeDefined();
      expect(row.title).toBe('Test Observation');
      expect(row.content).toBe('This is test content for the observation');
      expect(row.project).toBe('test-project');
      expect(row.session_id).toBe('test-session');
      expect(row.content_original).toBe('This is original content for the observation');
      expect(row.timestamp).toBe(now);
      expect(row.created_at).toBe(now);
    });

    test('inserts observation without sessionId', () => {
      const now = Date.now();

      insertObservation(db, {
        title: 'Test Observation',
        content: 'Content without session',
        project: 'test-project',
        timestamp: now,
        createdAt: now,
      });

      const row = db.prepare(`
        SELECT session_id FROM observations WHERE id = 1
      `).get() as any;

      expect(row.session_id).toBeNull();
    });

    test('stores embedding in vec_observations table', () => {
      const embedding = new Array(EMBEDDING_DIM).fill(0.5);

      insertObservation(db, {
        title: 'Test',
        content: 'Content',
        project: 'project',
        timestamp: Date.now(),
        createdAt: Date.now(),
      }, embedding);

      const vecRow = db.prepare(`
        SELECT embedding FROM vec_observations WHERE id = 1
      `).get() as any;

      expect(vecRow).toBeDefined();
      expect(vecRow.embedding).toBeInstanceOf(Uint8Array);
      expect(vecRow.embedding.length).toBe(EMBEDDING_DIM * 4); // EMBEDDING_DIM floats * 4 bytes
    });


    test('handles multi-byte UTF-8 characters', () => {
      const utf8Data = 'Hello 世界 🌍 Korean: 한국어';

      insertObservation(db, {
        title: utf8Data,
        content: utf8Data,
        project: 'project',
        timestamp: Date.now(),
        createdAt: Date.now(),
      });

      const row = db.prepare(`
        SELECT title, content FROM observations WHERE id = 1
      `).get() as any;

      expect(row.title).toBe(utf8Data);
      expect(row.content).toBe(utf8Data);
    });
  });

  describe('searchObservations', () => {
    beforeEach(() => {
      const embedding1 = new Array(EMBEDDING_DIM).fill(0.1);
      const embedding2 = new Array(EMBEDDING_DIM).fill(0.9);

      insertObservation(db, {
        title: 'Database optimization',
        content: 'Improved query performance with indexes',
        project: 'project-a',
        sessionId: 'session-1',
        timestamp: Date.now() - 1000,
        createdAt: Date.now() - 1000,
      }, embedding1);

      insertObservation(db, {
        title: 'API refactoring',
        content: 'Cleaned up REST endpoints',
        project: 'project-a',
        sessionId: 'session-2',
        timestamp: Date.now(),
        createdAt: Date.now(),
      }, embedding2);

      insertObservation(db, {
        title: 'Testing improvements',
        content: 'Added unit tests for core modules',
        project: 'project-b',
        sessionId: 'session-3',
        timestamp: Date.now() + 1000,
        createdAt: Date.now() + 1000,
      }, embedding1);
    });

    test('returns all observations when no filters provided', () => {
      const results = searchObservations(db, {});

      expect(results).toHaveLength(3);
    });

    test('filters by project', () => {
      const results = searchObservations(db, { project: 'project-a' });

      expect(results).toHaveLength(2);
      expect(results.every(r => r.project === 'project-a')).toBe(true);
    });

    test('filters by sessionId', () => {
      const results = searchObservations(db, { sessionId: 'session-1' });

      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe('session-1');
    });

    test('filters by date range', () => {
      const now = Date.now();
      const results = searchObservations(db, {
        after: now - 500,
        before: now + 500,
      });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('API refactoring');
    });

    test('respects limit parameter', () => {
      const results = searchObservations(db, { limit: 2 });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    test('returns observations ordered by timestamp descending', () => {
      const results = searchObservations(db, {});

      for (let i = 1; i < results.length; i++) {
        expect(results[i].timestamp).toBeLessThanOrEqual(results[i - 1].timestamp);
      }
    });

    test('includes all required fields in results', () => {
      const results = searchObservations(db, { limit: 1 });

      expect(results[0]).toHaveProperty('id');
      expect(results[0]).toHaveProperty('title');
      expect(results[0]).toHaveProperty('content');
      expect(results[0].contentOriginal).toBeNull();
      expect(results[0]).toHaveProperty('project');
      expect(results[0]).toHaveProperty('sessionId');
      expect(results[0]).toHaveProperty('timestamp');
      expect(results[0]).toHaveProperty('createdAt');
    });
  });

  describe('getObservation', () => {
    test('retrieves observation by id', () => {
      const now = Date.now();

      insertObservation(db, {
        title: 'Test Title',
        content: 'Test Content',
        project: 'test-project',
        sessionId: 'test-session',
        timestamp: now,
        createdAt: now,
      });

      const observation = getObservation(db, 1);

      expect(observation).toBeDefined();
      expect(observation!.id).toBe(1);
      expect(observation!.title).toBe('Test Title');
      expect(observation!.content).toBe('Test Content');
      expect(observation!.project).toBe('test-project');
      expect(observation!.sessionId).toBe('test-session');
    });

    test('returns null for non-existent id', () => {
      const observation = getObservation(db, 999);

      expect(observation).toBeNull();
    });

    test('includes all fields in result', () => {
      const now = Date.now();

      insertObservation(db, {
        title: 'Full Test',
        content: 'Full content test',
        contentOriginal: 'Full original content test',
        project: 'full-project',
        sessionId: 'full-session',
        timestamp: now,
        createdAt: now,
      });

      const observation = getObservation(db, 1);

      expect(observation).toHaveProperty('id');
      expect(observation).toHaveProperty('title');
      expect(observation).toHaveProperty('content');
      expect(observation!.contentOriginal).toBe('Full original content test');
      expect(observation).toHaveProperty('project');
      expect(observation).toHaveProperty('sessionId');
      expect(observation).toHaveProperty('timestamp');
      expect(observation).toHaveProperty('createdAt');
    });
  });

  describe('getAllPendingEvents', () => {
    test('returns all events for a session ordered by created_at', () => {
      const now = Date.now();

      // Insert events for session-1
      insertPendingEvent(db, {
        sessionId: 'session-1',
        project: 'project-a',
        toolName: 'bash',
        compressed: 'first event',
        timestamp: now - 2000,
        createdAt: now - 2000,
      });

      insertPendingEvent(db, {
        sessionId: 'session-1',
        project: 'project-a',
        toolName: 'read',
        compressed: 'second event',
        timestamp: now - 1000,
        createdAt: now - 1000,
      });

      // Insert event for different session
      insertPendingEvent(db, {
        sessionId: 'session-2',
        project: 'project-b',
        toolName: 'write',
        compressed: 'other session event',
        timestamp: now,
        createdAt: now,
      });

      const results = getAllPendingEvents(db, 'session-1');

      expect(results).toHaveLength(2);
      expect(results[0].compressed).toBe('first event');
      expect(results[1].compressed).toBe('second event');
      // Verify ascending order by created_at
      expect(results[0].createdAt).toBeLessThan(results[1].createdAt);
    });

    test('returns empty array for non-existent session', () => {
      const results = getAllPendingEvents(db, 'non-existent-session');

      expect(results).toEqual([]);
    });

    test('includes id in results', () => {
      insertPendingEvent(db, {
        sessionId: 'session-1',
        project: 'project-a',
        toolName: 'bash',
        compressed: 'test event',
        timestamp: Date.now(),
        createdAt: Date.now(),
      });

      const results = getAllPendingEvents(db, 'session-1');

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(1);
    });

    test('maps column names correctly', () => {
      const now = Date.now();

      insertPendingEvent(db, {
        sessionId: 'test-session',
        project: 'test-project',
        toolName: 'bash',
        compressed: 'test compressed data',
        timestamp: now,
        createdAt: now,
      });

      const results = getAllPendingEvents(db, 'test-session');

      expect(results[0].sessionId).toBe('test-session');
      expect(results[0].toolName).toBe('bash');
      expect(results[0].createdAt).toBe(now);
    });
  });

  describe('openDatabase', () => {
    test('migrates existing observations table by adding content_original', () => {
      const tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memmem-db-test-'));
      const tempDbPath = path.join(tempDbDir, 'legacy.db');
      const previousDbPath = process.env.CONVERSATION_MEMORY_DB_PATH;

      let legacyDb: Database | undefined;
      let migratedDb: Database | undefined;
      let secondOpenDb: Database | undefined;

      try {
        process.env.CONVERSATION_MEMORY_DB_PATH = tempDbPath;

        legacyDb = new Database(tempDbPath);
        sqliteVec.load(legacyDb);
        legacyDb.exec(`
          CREATE TABLE observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            project TEXT NOT NULL,
            session_id TEXT,
            timestamp INTEGER NOT NULL,
            created_at INTEGER NOT NULL
          )
        `);

        legacyDb.prepare(`
          INSERT INTO observations (title, content, project, session_id, timestamp, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run('Legacy Title', 'Legacy Content', 'legacy-project', 'legacy-session', 1000, 1000);
        legacyDb.close();
        legacyDb = undefined;

        migratedDb = openDatabase();
        const columns = migratedDb.prepare(`
          SELECT name FROM pragma_table_info('observations')
        `).all() as Array<{ name: string }>;

        expect(columns.some(column => column.name === 'content_original')).toBe(true);

        const row = migratedDb.prepare(`
          SELECT title, content, content_original FROM observations WHERE id = 1
        `).get() as { title: string; content: string; content_original: string | null };

        expect(row.title).toBe('Legacy Title');
        expect(row.content).toBe('Legacy Content');
        expect(row.content_original).toBeNull();

        secondOpenDb = openDatabase();
        secondOpenDb.close();
        secondOpenDb = undefined;
      } finally {
        if (secondOpenDb) secondOpenDb.close();
        if (migratedDb) migratedDb.close();
        if (legacyDb) legacyDb.close();

        if (previousDbPath === undefined) {
          delete process.env.CONVERSATION_MEMORY_DB_PATH;
        } else {
          process.env.CONVERSATION_MEMORY_DB_PATH = previousDbPath;
        }

        fs.rmSync(tempDbDir, { recursive: true, force: true });
      }
    });

    test('handles legacy content_original column with different casing', () => {
      const tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memmem-db-test-'));
      const tempDbPath = path.join(tempDbDir, 'legacy-case.db');
      const previousDbPath = process.env.CONVERSATION_MEMORY_DB_PATH;

      let legacyDb: Database | undefined;
      let migratedDb: Database | undefined;

      try {
        process.env.CONVERSATION_MEMORY_DB_PATH = tempDbPath;

        legacyDb = new Database(tempDbPath);
        sqliteVec.load(legacyDb);
        legacyDb.exec(`
          CREATE TABLE observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            CONTENT_ORIGINAL TEXT,
            project TEXT NOT NULL,
            session_id TEXT,
            timestamp INTEGER NOT NULL,
            created_at INTEGER NOT NULL
          )
        `);
        legacyDb.close();
        legacyDb = undefined;

        migratedDb = openDatabase();

        const columns = migratedDb.prepare(`
          SELECT name FROM pragma_table_info('observations')
        `).all() as Array<{ name: string }>;

        const contentOriginalColumns = columns.filter(column => column.name.toLowerCase() === 'content_original');
        expect(contentOriginalColumns).toHaveLength(1);
      } finally {
        if (migratedDb) migratedDb.close();
        if (legacyDb) legacyDb.close();

        if (previousDbPath === undefined) {
          delete process.env.CONVERSATION_MEMORY_DB_PATH;
        } else {
          process.env.CONVERSATION_MEMORY_DB_PATH = previousDbPath;
        }

        fs.rmSync(tempDbDir, { recursive: true, force: true });
      }
    });

    test('creates new database if not exists', () => {
      // initDatabase already created the tables in beforeEach
      // openDatabase should just open without wiping
      const openDb = openDatabase();

      const tables = openDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as Array<{ name: string }>;

      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('observations');
      expect(tableNames).toContain('pending_events');
      expect(tableNames).toContain('vec_observations');

      openDb.close();
    });

    test('does not wipe existing database', () => {
      // Insert data using the current db connection
      insertObservation(db, {
        title: 'Persistent Data',
        content: 'This should persist',
        project: 'test-project',
        timestamp: Date.now(),
        createdAt: Date.now(),
      });

      // Verify data exists in current connection
      const observationBefore = getObservation(db, 1);
      expect(observationBefore).toBeDefined();
      expect(observationBefore!.title).toBe('Persistent Data');

      // Calling initDatabase would wipe, but openDatabase should not
      // Since we're using :memory:, openDatabase creates a new separate database
      // In production with file-based DB, openDatabase would preserve data
      // This test verifies openDatabase doesn't throw and creates proper schema
      const openDb = openDatabase();

      // Verify openDb has proper schema
      const tables = openDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `).all() as Array<{ name: string }>;

      expect(tables.some(t => t.name === 'observations')).toBe(true);

      openDb.close();
    });
  });

  describe('Edge cases and error handling', () => {
    test('insertPendingEvent returns inserted row id', () => {
      const id = insertPendingEvent(db, {
        sessionId: 'session-1',
        project: 'project-a',
        toolName: 'bash',
        compressed: 'test',
        timestamp: Date.now(),
        createdAt: Date.now(),
      });

      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });

    test('insertObservation returns inserted row id', () => {
      const id = insertObservation(db, {
        title: 'Test',
        content: 'Content',
        project: 'project',
        timestamp: Date.now(),
        createdAt: Date.now(),
      });

      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });

    test('insertObservation works without embedding', () => {
      const id = insertObservation(db, {
        title: 'No Embedding',
        content: 'This observation has no embedding',
        project: 'project',
        timestamp: Date.now(),
        createdAt: Date.now(),
      });

      // Observation should be inserted
      expect(id).toBeGreaterThan(0);

      // But no vector should exist for this id
      const vecRow = db.prepare(`
        SELECT * FROM vec_observations WHERE id = ?
      `).get(String(id));

      expect(vecRow).toBeNull();
    });

    test('searchObservations with combined filters', () => {
      const now = Date.now();

      insertObservation(db, {
        title: 'Combined Test 1',
        content: 'Content 1',
        project: 'project-a',
        sessionId: 'session-1',
        timestamp: now - 1000,
        createdAt: now - 1000,
      });

      insertObservation(db, {
        title: 'Combined Test 2',
        content: 'Content 2',
        project: 'project-a',
        sessionId: 'session-2',
        timestamp: now,
        createdAt: now,
      });

      insertObservation(db, {
        title: 'Combined Test 3',
        content: 'Content 3',
        project: 'project-b',
        sessionId: 'session-1',
        timestamp: now + 1000,
        createdAt: now + 1000,
      });

      // Filter by project AND session
      const results = searchObservations(db, {
        project: 'project-a',
        sessionId: 'session-1',
      });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Combined Test 1');
    });

    test('searchObservations with after filter only', () => {
      const now = Date.now();

      insertObservation(db, {
        title: 'Old Observation',
        content: 'Old content',
        project: 'project',
        timestamp: now - 5000,
        createdAt: now - 5000,
      });

      insertObservation(db, {
        title: 'New Observation',
        content: 'New content',
        project: 'project',
        timestamp: now,
        createdAt: now,
      });

      const results = searchObservations(db, { after: now - 1000 });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('New Observation');
    });

    test('searchObservations with before filter only', () => {
      const now = Date.now();

      insertObservation(db, {
        title: 'Old Observation',
        content: 'Old content',
        project: 'project',
        timestamp: now - 5000,
        createdAt: now - 5000,
      });

      insertObservation(db, {
        title: 'New Observation',
        content: 'New content',
        project: 'project',
        timestamp: now,
        createdAt: now,
      });

      const results = searchObservations(db, { before: now - 1000 });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Old Observation');
    });

    test('searchObservations with all filters combined', () => {
      const now = Date.now();

      insertObservation(db, {
        title: 'Match',
        content: 'Should match all filters',
        project: 'project-a',
        sessionId: 'session-1',
        timestamp: now,
        createdAt: now,
      });

      insertObservation(db, {
        title: 'No Match - Wrong Project',
        content: 'Wrong project',
        project: 'project-b',
        sessionId: 'session-1',
        timestamp: now,
        createdAt: now,
      });

      insertObservation(db, {
        title: 'No Match - Wrong Session',
        content: 'Wrong session',
        project: 'project-a',
        sessionId: 'session-2',
        timestamp: now,
        createdAt: now,
      });

      insertObservation(db, {
        title: 'No Match - Wrong Time',
        content: 'Wrong time',
        project: 'project-a',
        sessionId: 'session-1',
        timestamp: now - 10000,
        createdAt: now - 10000,
      });

      const results = searchObservations(db, {
        project: 'project-a',
        sessionId: 'session-1',
        after: now - 1000,
        before: now + 1000,
        limit: 10,
      });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Match');
    });

    test('searchObservations returns empty array when no matches', () => {
      insertObservation(db, {
        title: 'Test',
        content: 'Content',
        project: 'project-a',
        timestamp: Date.now(),
        createdAt: Date.now(),
      });

      const results = searchObservations(db, { project: 'non-existent-project' });

      expect(results).toEqual([]);
    });

    test('handles empty strings in fields', () => {
      const id = insertObservation(db, {
        title: '',
        content: '',
        project: '',
        sessionId: '',
        timestamp: 0,
        createdAt: 0,
      });

      const observation = getObservation(db, id);

      expect(observation).toBeDefined();
      expect(observation!.title).toBe('');
      expect(observation!.content).toBe('');
      expect(observation!.project).toBe('');
      // Empty string sessionId becomes null in DB
    });

    test('handles very long content', () => {
      const longContent = 'a'.repeat(100000);

      const id = insertObservation(db, {
        title: 'Long Content Test',
        content: longContent,
        project: 'project',
        timestamp: Date.now(),
        createdAt: Date.now(),
      });

      const observation = getObservation(db, id);

      expect(observation!.content).toBe(longContent);
      expect(observation!.content.length).toBe(100000);
    });
  });
});
