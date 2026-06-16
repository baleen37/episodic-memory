import { afterEach, describe, expect, test } from 'bun:test';
import {
  CURRENT_EMBEDDING_VERSION,
  CURRENT_EXTRACTION_VERSION,
  initDatabase,
  insertMemoryRecord,
  insertMemoryRecordVector,
} from './db.js';
import { __setModelForTests } from './embeddings.js';
import { resetRateLimiters } from './ratelimiter.js';
import { search, searchMulti, listRecent } from './search.js';

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
    projectName: null,
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
  resetRateLimiters();
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

describe('listRecent', () => {
  test('returns active records in reverse chronological order without query or embeddings', () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();

    const oldId = insertMemoryRecord(db, memory({
      text: 'Oldest event.',
      observedAt: Date.UTC(2026, 5, 14),
      dedupeKey: 'recent-old',
    }));
    const midId = insertMemoryRecord(db, memory({
      text: 'Middle event.',
      observedAt: Date.UTC(2026, 5, 15),
      dedupeKey: 'recent-mid',
    }));
    const newId = insertMemoryRecord(db, memory({
      text: 'Newest event.',
      observedAt: Date.UTC(2026, 5, 16),
      dedupeKey: 'recent-new',
    }));

    const results = listRecent({ db, limit: 10 });

    expect(results.map(r => r.id)).toEqual([newId, midId, oldId]);
    expect(results[0]).not.toHaveProperty('score');
  });

  test('filters to a single day with after/before for "what did I do today"', () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();

    insertMemoryRecord(db, memory({
      text: 'Yesterday.',
      observedAt: Date.UTC(2026, 5, 15),
      dedupeKey: 'recent-yesterday',
    }));
    const todayId = insertMemoryRecord(db, memory({
      text: 'Today.',
      observedAt: Date.UTC(2026, 5, 16, 9, 0, 0),
      dedupeKey: 'recent-today',
    }));

    const results = listRecent({ db, limit: 10, after: '2026-06-16', before: '2026-06-16' });

    expect(results.map(r => r.id)).toEqual([todayId]);
  });

  test('respects limit and excludes superseded records', () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();

    insertMemoryRecord(db, memory({
      text: 'Superseded.',
      status: 'superseded',
      observedAt: Date.UTC(2026, 5, 16),
      dedupeKey: 'recent-superseded',
    }));
    const a = insertMemoryRecord(db, memory({
      text: 'Active A.',
      observedAt: Date.UTC(2026, 5, 15),
      dedupeKey: 'recent-active-a',
    }));
    insertMemoryRecord(db, memory({
      text: 'Active B.',
      observedAt: Date.UTC(2026, 5, 14),
      dedupeKey: 'recent-active-b',
    }));

    const results = listRecent({ db, limit: 1 });

    expect(results.map(r => r.id)).toEqual([a]);
  });
});

// Helper: 384-dim 벡터를 만들되 index `hot`만 1.0, 나머지 0.0
function hotVector(hot: number): number[] {
  return Array.from({ length: 384 }, (_, i) => (i === hot ? 1.0 : 0.0));
}

describe('searchMulti', () => {
  // 쿼리 텍스트 → 임베딩 벡터 매핑:
  //   "alpha-query"  → hotVector(0)  (index 0 = 1.0)
  //   "beta-query"   → hotVector(1)  (index 1 = 1.0)
  //   그 외 (레코드 텍스트 등) → hotVector(2)  (기본값, 검색과 무관한 벡터)
  function makeQueryEmbed() {
    return async (_kind: string, text: string): Promise<number[]> => {
      if (text === 'alpha-query') return hotVector(0);
      if (text === 'beta-query') return hotVector(1);
      return hotVector(2);
    };
  }

  test('AND intersection: 두 쿼리 모두에 나타난 레코드만 반환한다', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, makeQueryEmbed());

    // record1: hotVector(0) → alpha-query와 가깝, beta-query와 멈
    const id1 = insertMemoryRecord(db, memory({ text: 'record alpha only', dedupeKey: 'multi-r1' }));
    insertMemoryRecordVector(db, id1, hotVector(0));

    // record2: hotVector(1) → beta-query와 가깝, alpha-query와 멈
    const id2 = insertMemoryRecord(db, memory({ text: 'record beta only', dedupeKey: 'multi-r2' }));
    insertMemoryRecordVector(db, id2, hotVector(1));

    // record3: 벡터 없음 → 어느 vector search에서도 나오지 않음
    const id3 = insertMemoryRecord(db, memory({ text: 'record no vector', dedupeKey: 'multi-r3' }));
    void id3; // 의도적으로 벡터 미삽입

    // candidateLimit = 10 * 5 = 50 → 벡터 있는 2개 레코드 모두 각 쿼리에서 반환됨
    // alpha-query vectorSearch → [id1(dist≈0), id2(dist≈√2)]
    // beta-query  vectorSearch → [id2(dist≈0), id1(dist≈√2)]
    // 교집합 → id1, id2 모두 (둘 다 두 쿼리에 등장)
    // record3는 벡터가 없으므로 어디에도 없음 → 교집합에 미포함
    const results = await searchMulti(['alpha-query', 'beta-query'], { db, limit: 10 });

    const ids = results.map(r => r.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids).not.toContain(id3);
    expect(ids).toHaveLength(2);
  });

  test('mean scoring: 교집합 레코드의 score는 각 쿼리 score의 평균이다', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, makeQueryEmbed());

    // alpha-query → hotVector(0) = [1,0,...], beta-query → hotVector(1) = [0,1,...]
    // record vec = [0.7071, 0.7071, 0, ...] → 두 쿼리와 동일한 L2 거리
    // L2^2 = (1-0.7071)^2 + (0-0.7071)^2 = 0.0858 + 0.4999 = 0.5857 (대칭)
    // distance = sqrt(0.5857), score = 1/(1+sqrt(0.5857))
    // 두 쿼리의 score가 동일하므로 mean = score
    const vec = Array.from({ length: 384 }, (_, i) =>
      i === 0 ? 0.7071 : i === 1 ? 0.7071 : 0.0,
    );
    const id = insertMemoryRecord(db, memory({ text: 'record both', dedupeKey: 'multi-mean' }));
    insertMemoryRecordVector(db, id, vec);

    // 예상 score: 두 쿼리 모두 동일한 L2 거리이므로 mean = 개별 score
    const expectedDist = Math.sqrt((1 - 0.7071) ** 2 + (0 - 0.7071) ** 2);
    const expectedScore = 1 / (1 + expectedDist);

    const results = await searchMulti(['alpha-query', 'beta-query'], { db, limit: 10 });
    const rec = results.find(r => r.id === id);

    expect(rec).toBeDefined();
    // score는 두 쿼리 score의 평균 = expectedScore (대칭이므로)
    expect(rec!.score).toBeCloseTo(expectedScore, 3);
  });

  test('sort + limit: 결과는 score 내림차순이고 limit을 넘지 않는다', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, makeQueryEmbed());

    // 5개 레코드 모두 두 쿼리 벡터 사이의 서로 다른 위치에 삽입
    for (let i = 0; i < 5; i++) {
      const w = (i + 1) / 6; // 0.166 ~ 0.833
      const vec = Array.from({ length: 384 }, (_, dim) =>
        dim === 0 ? w : dim === 1 ? (1 - w) : 0.0,
      );
      const rid = insertMemoryRecord(db, memory({ text: `sort record ${i}`, dedupeKey: `multi-sort-${i}` }));
      insertMemoryRecordVector(db, rid, vec);
    }

    const results = await searchMulti(['alpha-query', 'beta-query'], { db, limit: 3 });

    expect(results.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < results.length; i++) {
      expect((results[i - 1].score ?? 0)).toBeGreaterThanOrEqual(results[i].score ?? 0);
    }
  });

  test('empty intersection: 벡터가 없는 DB에서는 빈 배열을 반환한다', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, makeQueryEmbed());

    // 레코드는 있지만 벡터 없음 → vectorSearch 결과 = 빈 배열 → 교집합 = 빈 배열
    insertMemoryRecord(db, memory({ text: 'no vector record', dedupeKey: 'multi-empty' }));

    const results = await searchMulti(['alpha-query', 'beta-query'], { db, limit: 10 });

    expect(results).toEqual([]);
  });

  test('single-element array: search()와 동일한 id 집합을 반환한다', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, makeQueryEmbed());

    for (let i = 0; i < 3; i++) {
      const rid = insertMemoryRecord(db, memory({ text: `single test record ${i}`, dedupeKey: `multi-single-${i}` }));
      insertMemoryRecordVector(db, rid, hotVector(i % 3));
    }

    const singleMulti = await searchMulti(['alpha-query'], { db, limit: 10 });
    const singleSearch = await search('alpha-query', { db, limit: 10 });

    expect(new Set(singleMulti.map(r => r.id))).toEqual(new Set(singleSearch.map(r => r.id)));
  });

  test('wide candidate pool: 각 쿼리 상위권 밖이지만 둘 다에 관련된 레코드도 교집합에 포함된다', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, makeQueryEmbed());

    // 교집합 레코드 X: 두 쿼리(hotVector(0), hotVector(1)) 사이의 중간 지점.
    // 각 쿼리에 대해 distance ≈ sqrt(0.5) 정도로 "어느 정도 관련" 있지만 최상위는 아님.
    const xVec = Array.from({ length: 384 }, (_, i) => (i === 0 || i === 1 ? 0.5 : 0.0));
    const xId = insertMemoryRecord(db, memory({ text: 'record relevant to both', dedupeKey: 'wide-x' }));
    insertMemoryRecordVector(db, xId, xVec);

    // noise 레코드를 많이 넣어 X를 각 쿼리의 상위 후보(limit*5=50) 밖으로 밀어낸다.
    // alpha 쪽 noise: hotVector(0)에 X보다 가까운 [0.9, 0, ...] → alpha top에 들어와 X를 밀어냄.
    // beta 쪽 noise: hotVector(1)에 가까운 [0, 0.9, ...] → beta top에 들어와 X를 밀어냄.
    for (let i = 0; i < 60; i++) {
      const aVec = Array.from({ length: 384 }, (_, d) => (d === 0 ? 0.9 : 0.0));
      const aId = insertMemoryRecord(db, memory({ text: `alpha noise ${i}`, dedupeKey: `wide-a-${i}` }));
      insertMemoryRecordVector(db, aId, aVec);

      const bVec = Array.from({ length: 384 }, (_, d) => (d === 1 ? 0.9 : 0.0));
      const bId = insertMemoryRecord(db, memory({ text: `beta noise ${i}`, dedupeKey: `wide-b-${i}` }));
      insertMemoryRecordVector(db, bId, bVec);
    }

    // X는 두 쿼리 모두에 관련되므로 AND 교집합에 포함되어야 한다.
    // 좁은 후보 풀(이전 구현: limit*5=50)에서는 X가 양쪽 상위 50 밖이라 누락되어 빈 결과가 났다(회귀 재현).
    const results = await searchMulti(['alpha-query', 'beta-query'], { db, limit: 200 });

    expect(results.map(r => r.id)).toContain(xId);
  });
});
