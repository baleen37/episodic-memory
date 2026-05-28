import { afterEach, describe, expect, test } from 'bun:test';
import { CURRENT_EMBEDDING_VERSION, initDatabase, insertExchange, insertExchangeVector, insertToolCall } from './db.js';
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

  test('filters text results by project', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));

    const alphaId = insertExchange(db, {
      archivePath: '/archive/claude-projects/alpha.jsonl', lineStart: 1, lineEnd: 2, sourceKind: 'claude-projects', sessionId: null, project: 'alpha', cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 26), userText: 'project text query', assistantText: 'alpha', embeddingText: 'project text query alpha', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertExchange(db, {
      archivePath: '/archive/claude-projects/beta.jsonl', lineStart: 3, lineEnd: 4, sourceKind: 'claude-projects', sessionId: null, project: 'beta', cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 27), userText: 'project text query', assistantText: 'beta', embeddingText: 'project text query beta', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    const results = await search('project text query', { db, limit: 10, projects: ['alpha'] });

    expect(results.map(result => result.id)).toEqual([alphaId]);
  });

  test('filters vector results by project', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));

    const alphaId = insertExchange(db, {
      archivePath: '/archive/claude-projects/alpha-vector.jsonl', lineStart: 1, lineEnd: 2, sourceKind: 'claude-projects', sessionId: null, project: 'alpha', cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 26), userText: 'alpha unrelated', assistantText: 'semantic only', embeddingText: 'alpha semantic only', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertExchangeVector(db, alphaId, Array.from({ length: 384 }, () => 0.1));
    const betaId = insertExchange(db, {
      archivePath: '/archive/claude-projects/beta-vector.jsonl', lineStart: 3, lineEnd: 4, sourceKind: 'claude-projects', sessionId: null, project: 'beta', cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 27), userText: 'beta unrelated', assistantText: 'semantic only', embeddingText: 'beta semantic only', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertExchangeVector(db, betaId, Array.from({ length: 384 }, () => 0.2));

    const results = await search('project-vector-query', { db, limit: 10, projects: ['beta'] });

    expect(results.map(result => result.id)).toEqual([betaId]);
  });

  test('filters results by archive path and tool call file substrings', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));

    const archiveId = insertExchange(db, {
      archivePath: '/archive/claude-projects/src-target.jsonl', lineStart: 1, lineEnd: 2, sourceKind: 'claude-projects', sessionId: null, project: null, cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 26), userText: 'archive unrelated', assistantText: 'semantic only', embeddingText: 'archive semantic only', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertExchangeVector(db, archiveId, Array.from({ length: 384 }, () => 0.1));
    const toolId = insertExchange(db, {
      archivePath: '/archive/claude-projects/tool.jsonl', lineStart: 3, lineEnd: 4, sourceKind: 'claude-projects', sessionId: null, project: null, cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 27), userText: 'tool unrelated', assistantText: 'semantic only', embeddingText: 'tool semantic only', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertExchangeVector(db, toolId, Array.from({ length: 384 }, () => 0.2));
    insertToolCall(db, { exchangeId: toolId, toolName: 'Read', callId: null, input: '/repo/tool-target.ts', output: null, status: 'success' });
    const otherId = insertExchange(db, {
      archivePath: '/archive/claude-projects/other.jsonl', lineStart: 5, lineEnd: 6, sourceKind: 'claude-projects', sessionId: null, project: null, cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 28), userText: 'other unrelated', assistantText: 'semantic only', embeddingText: 'other semantic only', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertExchangeVector(db, otherId, Array.from({ length: 384 }, () => 0.3));

    const archiveResults = await search('files-vector-query', { db, limit: 10, files: ['src-target'] });
    const toolResults = await search('files-vector-query', { db, limit: 10, files: ['tool-target.ts'] });

    expect(archiveResults.map(result => result.id)).toEqual([archiveId]);
    expect(toolResults.map(result => result.id)).toEqual([toolId]);
  });

  test('normalizes query for vector search and text fallback', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    let embeddedQuery = '';
    __setModelForTests(async () => {}, async (text: string) => {
      embeddedQuery = text;
      return Array.from({ length: 384 }, () => 0.1);
    });
    let prompt = '';
    const queryNormalizerProvider = {
      complete: async (input: string) => {
        prompt = input;
        return { text: 'english normalized', usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };

    const id = insertExchange(db, {
      archivePath: '/archive/claude-projects/normalized.jsonl', lineStart: 1, lineEnd: 2, sourceKind: 'claude-projects', sessionId: null, project: null, cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 26), userText: 'english normalized', assistantText: 'text fallback', embeddingText: 'english normalized text fallback', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    const results = await search('한국어 질의', { db, limit: 10, queryNormalizerProvider });

    expect(prompt).toContain('한국어 질의');
    expect(embeddedQuery).toBe('english normalized');
    expect(results.map(result => result.id)).toEqual([id]);
  });

  test('treats LIKE wildcards as literal characters', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));

    const literalId = insertExchange(db, {
      archivePath: '/archive/claude-projects/literal.jsonl', lineStart: 1, lineEnd: 2, sourceKind: 'claude-projects', sessionId: null, project: null, cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 26), userText: 'literal 100% match', assistantText: 'result', embeddingText: 'literal 100 percent match', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertExchange(db, {
      archivePath: '/archive/claude-projects/wildcard.jsonl', lineStart: 3, lineEnd: 4, sourceKind: 'claude-projects', sessionId: null, project: null, cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 27), userText: 'literal 100abc match', assistantText: 'result', embeddingText: 'literal 100abc match', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    const results = await search('100%', { db, limit: 10 });

    expect(results.map(result => result.id)).toEqual([literalId]);
  });

  test('finds filtered vector result outside unfiltered top k', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));

    for (let i = 0; i < 2; i++) {
      const id = insertExchange(db, {
        archivePath: `/archive/claude-projects/closer-${i}.jsonl`, lineStart: 1, lineEnd: 2, sourceKind: 'claude-projects', sessionId: null, project: null, cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 26), userText: 'closer unrelated', assistantText: 'not the fallback term', embeddingText: 'closer unrelated', embeddingVersion: CURRENT_EMBEDDING_VERSION,
      });
      insertExchangeVector(db, id, Array.from({ length: 384 }, () => 0.1));
    }

    const codexId = insertExchange(db, {
      archivePath: '/archive/codex-sessions/filtered.jsonl', lineStart: 3, lineEnd: 4, sourceKind: 'codex-sessions', sessionId: null, project: null, cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 27), userText: 'codex body without fallback words', assistantText: 'semantic only match', embeddingText: 'codex semantic only match', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertExchangeVector(db, codexId, Array.from({ length: 384 }, () => 0.2));

    const results = await search('vector-filter-query', { db, limit: 2, sourceKind: 'codex-sessions' });

    expect(results.map(result => result.id)).toEqual([codexId]);
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
