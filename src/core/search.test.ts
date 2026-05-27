import { afterEach, describe, expect, test } from 'bun:test';
import { CURRENT_EMBEDDING_VERSION, initDatabase, insertExchange, insertExchangeVector } from './db.js';
import { __setModelForTests } from './embeddings.js';
import { search } from './search.js';

let db: ReturnType<typeof initDatabase> | null = null;

afterEach(() => {
  db?.close();
  db = null;
  __setModelForTests(null, null);
});

describe('exchange search', () => {
  test('returns vector results and text fallback results without duplicates', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));

    const vectorId = insertExchange(db, {
      archivePath: '/archive/claude-projects/a.jsonl', lineStart: 1, lineEnd: 2, sourceKind: 'claude-projects', sessionId: null, project: 'alpha', cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 26), userText: 'semantic memory', assistantText: 'vector result', embeddingText: 'semantic memory vector result', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertExchangeVector(db, vectorId, Array.from({ length: 384 }, () => 0.1));

    insertExchange(db, {
      archivePath: '/archive/codex-sessions/b.jsonl', lineStart: 3, lineEnd: 4, sourceKind: 'codex-sessions', sessionId: null, project: 'beta', cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 27), userText: 'exact phrase search', assistantText: 'text result', embeddingText: 'exact phrase search text result', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    const results = await search('exact phrase', { db, limit: 10 });

    expect(results.map(result => result.archivePath)).toContain('/archive/codex-sessions/b.jsonl');
    expect(new Set(results.map(result => result.id)).size).toBe(results.length);
  });

  test('filters by source kind and date', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));

    insertExchange(db, {
      archivePath: '/archive/claude-projects/a.jsonl', lineStart: 1, lineEnd: 2, sourceKind: 'claude-projects', sessionId: null, project: null, cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 25), userText: 'filter me', assistantText: 'old', embeddingText: 'filter me old', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertExchange(db, {
      archivePath: '/archive/codex-sessions/b.jsonl', lineStart: 1, lineEnd: 2, sourceKind: 'codex-sessions', sessionId: null, project: null, cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 26), userText: 'filter me', assistantText: 'new', embeddingText: 'filter me new', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    const results = await search('filter me', { db, limit: 10, after: '2026-05-26', sourceKind: 'codex-sessions' });

    expect(results).toHaveLength(1);
    expect(results[0].sourceKind).toBe('codex-sessions');
  });

  test('preserves null project and timestamp without legacy title', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));

    insertExchange(db, {
      archivePath: '/archive/claude-projects/nulls.jsonl', lineStart: 5, lineEnd: 6, sourceKind: 'claude-projects', sessionId: null, project: null, cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: null, userText: 'null shape', assistantText: 'result', embeddingText: 'null shape result', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    const results = await search('null shape', { db, limit: 10 });

    expect(results).toHaveLength(1);
    expect(results[0].project).toBeNull();
    expect(results[0].timestamp).toBeNull();
    expect(Object.keys(results[0]).sort()).toEqual([
      'archivePath',
      'id',
      'lineEnd',
      'lineStart',
      'project',
      'snippet',
      'sourceKind',
      'timestamp',
    ]);
    expect(results[0]).not.toHaveProperty('title');
  });
});
