import { afterEach, describe, expect, test } from 'bun:test';
import {
  CURRENT_EMBEDDING_VERSION,
  CURRENT_EXTRACTION_VERSION,
  initDatabase,
  insertMemoryRecord,
  insertMemoryRecordVector,
} from './db.js';
import { __setModelForTests } from './embeddings.js';
import { search } from './search.js';

let db: ReturnType<typeof initDatabase> | null = null;

function memory(overrides: Partial<Parameters<typeof insertMemoryRecord>[1]> = {}): Parameters<typeof insertMemoryRecord>[1] {
  const archivePath = overrides.archivePath ?? '/archive/a.jsonl';
  const text = overrides.text ?? 'The transcript archive is the source of truth.';
  return {
    kind: 'fact',
    text,
    sourceKind: 'claude-projects',
    archivePath,
    lineStart: 4,
    lineEnd: 8,
    observedAt: Date.UTC(2026, 5, 1),
    project: 'memmem',
    dedupeKey: `${archivePath}:${overrides.lineStart ?? 4}:${text}`,
    extractionVersion: CURRENT_EXTRACTION_VERSION,
    embeddingVersion: CURRENT_EMBEDDING_VERSION,
    ...overrides,
  };
}

afterEach(() => {
  db?.close();
  db = null;
  __setModelForTests(null, null);
});

describe('memory search', () => {
  test('returns compact memory records from vector search without snippets', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    const id = insertMemoryRecord(db, memory());
    insertMemoryRecordVector(db, id, Array.from({ length: 384 }, () => 0.1));

    const results = await search('source of truth', { db, limit: 5 });

    expect(results[0]).toEqual({
      id,
      kind: 'fact',
      text: 'The transcript archive is the source of truth.',
      sourceKind: 'claude-projects',
      archivePath: '/archive/a.jsonl',
      lineStart: 4,
      lineEnd: 8,
      observedAt: Date.UTC(2026, 5, 1),
      project: 'memmem',
      score: expect.any(Number),
    });
    expect(results[0]).not.toHaveProperty('snippet');
  });

  test('returns vector results and text fallback results without duplicates', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    const vectorId = insertMemoryRecord(db, memory({
      archivePath: '/archive/claude-projects/a.jsonl',
      text: 'Semantic memory vector result.',
      project: 'alpha',
      observedAt: Date.UTC(2026, 4, 26),
      dedupeKey: 'vector-result',
    }));
    insertMemoryRecordVector(db, vectorId, Array.from({ length: 384 }, () => 0.1));

    insertMemoryRecord(db, memory({
      archivePath: '/archive/codex-sessions/b.jsonl',
      sourceKind: 'codex-sessions',
      text: 'Exact phrase search text result.',
      project: 'beta',
      observedAt: Date.UTC(2026, 4, 27),
      dedupeKey: 'fallback-result',
    }));

    const results = await search('exact phrase', { db, limit: 10 });

    expect(results.map(result => result.archivePath)).toContain('/archive/codex-sessions/b.jsonl');
    expect(new Set(results.map(result => result.id)).size).toBe(results.length);
  });

  test('filters by source kind and date', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    insertMemoryRecord(db, memory({
      archivePath: '/archive/claude-projects/a.jsonl',
      text: 'Filter me old.',
      observedAt: Date.UTC(2026, 4, 25),
      dedupeKey: 'old-filter',
    }));
    insertMemoryRecord(db, memory({
      archivePath: '/archive/codex-sessions/b.jsonl',
      sourceKind: 'codex-sessions',
      text: 'Filter me new.',
      observedAt: Date.UTC(2026, 4, 26),
      dedupeKey: 'new-filter',
    }));

    const results = await search('filter me', { db, limit: 10, after: '2026-05-26', sourceKind: 'codex-sessions' });

    expect(results).toHaveLength(1);
    expect(results[0].sourceKind).toBe('codex-sessions');
  });

  test('filters text results by project', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    const alphaId = insertMemoryRecord(db, memory({
      archivePath: '/archive/claude-projects/alpha.jsonl',
      text: 'Project text query alpha.',
      project: 'alpha',
      dedupeKey: 'alpha-text',
    }));
    insertMemoryRecord(db, memory({
      archivePath: '/archive/claude-projects/beta.jsonl',
      text: 'Project text query beta.',
      project: 'beta',
      dedupeKey: 'beta-text',
    }));

    const results = await search('project text query', { db, limit: 10, projects: ['alpha'] });

    expect(results.map(result => result.id)).toEqual([alphaId]);
  });

  test('filters vector results by project', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    const alphaId = insertMemoryRecord(db, memory({
      archivePath: '/archive/claude-projects/alpha-vector.jsonl',
      text: 'Alpha semantic only.',
      project: 'alpha',
      dedupeKey: 'alpha-vector',
    }));
    insertMemoryRecordVector(db, alphaId, Array.from({ length: 384 }, () => 0.1));
    const betaId = insertMemoryRecord(db, memory({
      archivePath: '/archive/claude-projects/beta-vector.jsonl',
      text: 'Beta semantic only.',
      project: 'beta',
      dedupeKey: 'beta-vector',
    }));
    insertMemoryRecordVector(db, betaId, Array.from({ length: 384 }, () => 0.2));

    const results = await search('project-vector-query', { db, limit: 10, projects: ['beta'] });

    expect(results.map(result => result.id)).toEqual([betaId]);
  });

  test('normalizes query for vector search and text fallback', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    let embeddedQuery = '';
    __setModelForTests(async () => {}, async (_kind, text: string) => {
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

    const id = insertMemoryRecord(db, memory({
      archivePath: '/archive/claude-projects/normalized.jsonl',
      text: 'English normalized text fallback.',
      project: null,
      dedupeKey: 'normalized',
    }));

    const results = await search('한국어 질의', { db, limit: 10, queryNormalizerProvider });

    expect(prompt).toContain('한국어 질의');
    expect(embeddedQuery).toBe('english normalized');
    expect(results.map(result => result.id)).toEqual([id]);
  });

  test('treats LIKE wildcards as literal characters', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    const literalId = insertMemoryRecord(db, memory({
      archivePath: '/archive/claude-projects/literal.jsonl',
      text: 'Literal 100% match.',
      project: null,
      dedupeKey: 'literal-percent',
    }));
    insertMemoryRecord(db, memory({
      archivePath: '/archive/claude-projects/wildcard.jsonl',
      text: 'Literal 100abc match.',
      project: null,
      dedupeKey: 'wildcard-percent',
    }));

    const results = await search('100%', { db, limit: 10 });

    expect(results.map(result => result.id)).toEqual([literalId]);
  });

  test('finds filtered vector result outside unfiltered top k', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    for (let i = 0; i < 2; i++) {
      const id = insertMemoryRecord(db, memory({
        archivePath: `/archive/claude-projects/closer-${i}.jsonl`,
        text: 'Closer unrelated.',
        dedupeKey: `closer-${i}`,
      }));
      insertMemoryRecordVector(db, id, Array.from({ length: 384 }, () => 0.1));
    }

    const codexId = insertMemoryRecord(db, memory({
      archivePath: '/archive/codex-sessions/filtered.jsonl',
      sourceKind: 'codex-sessions',
      text: 'Codex semantic only match.',
      dedupeKey: 'codex-filtered-vector',
    }));
    insertMemoryRecordVector(db, codexId, Array.from({ length: 384 }, () => 0.2));

    const results = await search('vector-filter-query', { db, limit: 2, sourceKind: 'codex-sessions' });

    expect(results.map(result => result.id)).toEqual([codexId]);
  });

  test('returns active vector result when closer superseded vector fills top k', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    const supersededId = insertMemoryRecord(db, memory({
      archivePath: '/archive/claude-projects/superseded-vector.jsonl',
      text: 'Superseded semantic only memory.',
      status: 'superseded',
      dedupeKey: 'superseded-vector-top-k',
    }));
    insertMemoryRecordVector(db, supersededId, Array.from({ length: 384 }, () => 0.1));

    const activeId = insertMemoryRecord(db, memory({
      archivePath: '/archive/claude-projects/active-vector.jsonl',
      text: 'Active semantic only memory.',
      dedupeKey: 'active-vector-after-superseded',
    }));
    insertMemoryRecordVector(db, activeId, Array.from({ length: 384 }, () => 0.2));

    const results = await search('vector-only-query', { db, limit: 1 });

    expect(results.map(result => result.id)).toEqual([activeId]);
  });

  test('preserves null project and observedAt without legacy title or snippet', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    insertMemoryRecord(db, memory({
      archivePath: '/archive/claude-projects/nulls.jsonl',
      text: 'Null shape result.',
      lineStart: 5,
      lineEnd: 6,
      observedAt: null,
      project: null,
      dedupeKey: 'null-shape',
    }));

    const results = await search('null shape', { db, limit: 10 });

    expect(results).toHaveLength(1);
    expect(results[0].project).toBeNull();
    expect(results[0].observedAt).toBeNull();
    expect(Object.keys(results[0]).sort()).toEqual([
      'archivePath',
      'id',
      'kind',
      'lineEnd',
      'lineStart',
      'observedAt',
      'project',
      'sourceKind',
      'text',
    ]);
    expect(results[0]).not.toHaveProperty('title');
    expect(results[0]).not.toHaveProperty('snippet');
  });

  test('omits superseded records and truncates long memory text', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    const longText = `long query ${'a'.repeat(500)}`;
    const activeId = insertMemoryRecord(db, memory({
      archivePath: '/archive/claude-projects/long.jsonl',
      text: longText,
      dedupeKey: 'long-active',
    }));
    insertMemoryRecord(db, memory({
      archivePath: '/archive/claude-projects/superseded.jsonl',
      text: 'long query superseded',
      status: 'superseded',
      dedupeKey: 'long-superseded',
    }));

    const results = await search('long query', { db, limit: 10 });

    expect(results.map(result => result.id)).toEqual([activeId]);
    expect(results[0].text).toHaveLength(400);
    expect(results[0].text.endsWith('...')).toBe(true);
  });
});
