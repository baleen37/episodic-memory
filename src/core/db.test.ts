import { afterEach, describe, expect, test } from 'bun:test';
import { initDatabase, insertExchange, insertToolCall, deleteExchangeIndexForArchivePath, getArchivePathsNeedingReindex, CURRENT_EMBEDDING_VERSION, insertPendingEvent, insertObservation, createObservation, getAllPendingEvents, getRecentObservations, searchObservations, getObservationById, getObservation, getObservationsByIds } from './db.js';

let db: ReturnType<typeof initDatabase> | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe('exchange database schema', () => {
  test('creates exchange schema tables', () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();

    const tables = db.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual')").all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);

    expect(names).toContain('exchanges');
    expect(names).toContain('tool_calls');
    expect(names).toContain('vec_exchanges');
  });

  test('creates tool call exchange id index', () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();

    const indexes = db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
    const names = indexes.map(index => index.name);

    expect(names).toContain('idx_tool_calls_exchange_id');
  });

  test('inserts exchange and cascades tool calls on delete', () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();

    const exchangeId = insertExchange(db, {
      archivePath: '/tmp/archive/claude-projects/session.jsonl',
      lineStart: 1,
      lineEnd: 2,
      sourceKind: 'claude-projects',
      sessionId: 'session-1',
      project: 'project-a',
      cwd: '/tmp/project-a',
      gitBranch: 'main',
      model: 'claude-sonnet',
      provider: 'anthropic',
      metadataJson: JSON.stringify({ version: '1.0.0' }),
      timestamp: 1710000000000,
      userText: 'How should we index transcripts?',
      assistantText: 'Use exchange rows.',
      embeddingText: 'How should we index transcripts?\nUse exchange rows.',
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    insertToolCall(db, {
      exchangeId,
      toolName: 'Read',
      callId: 'toolu_1',
      input: '{"file_path":"src/core/db.ts"}',
      output: 'file content',
      status: 'success',
    });

    deleteExchangeIndexForArchivePath(db, '/tmp/archive/claude-projects/session.jsonl');

    const toolCount = db.query('SELECT COUNT(*) AS count FROM tool_calls').get() as { count: number };
    expect(toolCount.count).toBe(0);
  });

  test('finds archive paths missing exchange rows or stale embeddings', () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();

    insertExchange(db, {
      archivePath: '/tmp/archive/codex-sessions/rollout.jsonl',
      lineStart: 1,
      lineEnd: 3,
      sourceKind: 'codex-sessions',
      sessionId: 'codex-session',
      project: 'project-b',
      cwd: '/tmp/project-b',
      gitBranch: null,
      model: 'gpt-5.1',
      provider: 'openai',
      metadataJson: null,
      timestamp: 1710000000000,
      userText: 'Run tests',
      assistantText: 'Tests passed',
      embeddingText: 'Run tests\nTests passed',
      embeddingVersion: CURRENT_EMBEDDING_VERSION - 1,
    });

    const paths = getArchivePathsNeedingReindex(db, ['/tmp/archive/codex-sessions/rollout.jsonl', '/tmp/archive/claude-projects/new.jsonl']);
    expect(paths.sort()).toEqual(['/tmp/archive/claude-projects/new.jsonl', '/tmp/archive/codex-sessions/rollout.jsonl']);
  });

  test('finds archive paths with current exchange rows but missing vector rows', () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();

    insertExchange(db, {
      archivePath: '/tmp/archive/claude-projects/no-vector.jsonl',
      lineStart: 1,
      lineEnd: 2,
      sourceKind: 'claude-projects',
      sessionId: 'session-without-vector',
      project: 'project-c',
      cwd: '/tmp/project-c',
      gitBranch: 'main',
      model: 'claude-sonnet',
      provider: 'anthropic',
      metadataJson: null,
      timestamp: 1710000000000,
      userText: 'Index this',
      assistantText: 'Missing vector row',
      embeddingText: 'Index this\nMissing vector row',
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    const paths = getArchivePathsNeedingReindex(db, ['/tmp/archive/claude-projects/no-vector.jsonl']);
    expect(paths).toEqual(['/tmp/archive/claude-projects/no-vector.jsonl']);
  });

  test('legacy observation schema exports fail with explicit removed-schema errors', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();

    expect(() => insertPendingEvent(db!, {
      sessionId: 'session-1',
      project: 'project-a',
      toolName: 'Read',
      summary: 'Read file',
      timestamp: 1710000000000,
      createdAt: 1710000000000,
    })).toThrow('Observation schema has been removed');
    expect(() => insertObservation(db!, {
      title: 'Legacy observation',
      content: 'Legacy content',
      project: 'project-a',
      timestamp: 1710000000000,
      createdAt: 1710000000000,
    })).toThrow('Observation schema has been removed');
    await expect(createObservation(db!, 'Legacy observation', 'Legacy content', 'project-a')).rejects.toThrow('Observation schema has been removed');
    expect(() => getAllPendingEvents(db!, 'session-1')).toThrow('Observation schema has been removed');
    expect(() => getRecentObservations(db!)).toThrow('Observation schema has been removed');
    expect(() => searchObservations(db!)).toThrow('Observation schema has been removed');
    expect(() => getObservationById(db!, 1)).toThrow('Observation schema has been removed');
    expect(() => getObservation(db!, 1)).toThrow('Observation schema has been removed');
    expect(() => getObservationsByIds(db!, [1])).toThrow('Observation schema has been removed');
  });
});
