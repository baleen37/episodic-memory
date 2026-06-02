import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleFetch, handleSearch } from './handlers.js';
import { CURRENT_EMBEDDING_VERSION, CURRENT_EXTRACTION_VERSION, initDatabase, insertMemoryRecord, insertMemoryRecordVector } from '../core/db.js';
import { __setModelForTests } from '../core/embeddings.js';
import { resetRateLimiters } from '../core/ratelimiter.js';

describe('handlers', () => {
  let db: Database;
  let dir: string | null = null;

  beforeEach(() => {
    process.env.TEST_DB_PATH = ':memory:';
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    delete process.env.TEST_DB_PATH;
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    __setModelForTests(null, null);
    resetRateLimiters();
  });

  test('maps search results to compact memory cards', async () => {
    insertMemoryRecord(db, {
      kind: 'fact',
      text: 'memory search transcript result',
      archivePath: '/archive/claude-projects/session.jsonl',
      lineStart: 2,
      lineEnd: 4,
      sourceKind: 'claude-projects',
      project: 'memmem',
      observedAt: Date.UTC(2026, 4, 26),
      dedupeKey: 'test-memory-search',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    const results = await handleSearch({ query: 'memory search', limit: 10 }, db);

    expect(results).toEqual([
      {
        id: '1',
        kind: 'fact',
        text: 'memory search transcript result',
      },
    ]);
  });

  test('fetch returns the source transcript for a record id', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-mcp-fetch-'));
    const archivePath = join(dir, 'session.jsonl');
    writeFileSync(archivePath, JSON.stringify({
      uuid: '1',
      type: 'user',
      timestamp: '2026-05-26T00:00:00.000Z',
      message: { role: 'user', content: 'Hello from transcript' },
    }) + '\n');

    insertMemoryRecord(db, {
      kind: 'fact',
      text: 'fetchable memory record',
      archivePath,
      lineStart: 1,
      lineEnd: 1,
      sourceKind: 'claude-projects',
      project: null,
      observedAt: Date.UTC(2026, 4, 26),
      dedupeKey: 'fetchable',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    const result = handleFetch({ id: 1 }, db);

    expect(result).toContain('# Conversation');
    expect(result).toContain('Hello from transcript');
  });

  test('fetch accepts a string id', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-mcp-fetch-str-'));
    const archivePath = join(dir, 'session.jsonl');
    writeFileSync(archivePath, JSON.stringify({
      uuid: '1',
      type: 'user',
      timestamp: '2026-05-26T00:00:00.000Z',
      message: { role: 'user', content: 'String id transcript' },
    }) + '\n');

    insertMemoryRecord(db, {
      kind: 'fact',
      text: 'string id memory record',
      archivePath,
      lineStart: 1,
      lineEnd: 1,
      sourceKind: 'claude-projects',
      project: null,
      observedAt: Date.UTC(2026, 4, 26),
      dedupeKey: 'string-id',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    expect(handleFetch({ id: '1' }, db)).toContain('String id transcript');
  });

  test('fetch throws when the record id is unknown', () => {
    expect(() => handleFetch({ id: 999 }, db)).toThrow('Memory record not found: 999');
  });

  // Helper: 384-dim 벡터에서 index `hot`만 1.0, 나머지 0.0
  function hotVec(hot: number): number[] {
    return Array.from({ length: 384 }, (_, i) => (i === hot ? 1.0 : 0.0));
  }

  // alpha(hotVec(0))에 가깝고 beta에서 먼 더미. slot마다 거리를 미세하게 달리해 동순위를 피한다.
  function alphaFiller(slot: number): number[] {
    const v = Array.from({ length: 384 }, () => 0.0);
    v[0] = 0.9;
    v[10 + slot] = 0.1;
    return v;
  }

  // beta(hotVec(1))에 가깝고 alpha에서 먼 더미.
  function betaFiller(slot: number): number[] {
    const v = Array.from({ length: 384 }, () => 0.0);
    v[1] = 0.9;
    v[20 + slot] = 0.1;
    return v;
  }

  function insertVectoredRecord(text: string, dedupeKey: string, vector: number[]): number {
    const id = insertMemoryRecord(db, {
      kind: 'fact',
      text,
      archivePath: `/archive/${dedupeKey}.jsonl`,
      lineStart: 1,
      lineEnd: 2,
      sourceKind: 'claude-projects',
      project: null,
      observedAt: Date.UTC(2026, 4, 26),
      dedupeKey,
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertMemoryRecordVector(db, id, vector);
    return id;
  }

  test('array query → AND intersection: 한 쿼리에만 매칭되는 레코드는 제외하고 둘 다 매칭되는 카드만 반환한다', async () => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    // "alpha" → hotVec(0), "beta" → hotVec(1)
    __setModelForTests(async () => {}, async (_kind: string, text: string) => {
      if (text === 'alpha') return hotVec(0);
      if (text === 'beta') return hotVec(1);
      return hotVec(2);
    });

    // limit=1 → searchMulti candidateLimit = 1 * 5 = 5 (각 쿼리당 vectorSearch LIMIT 5).
    //
    // 시드를 비대칭으로 구성해 각 쿼리의 후보 5자리를 다음과 같이 점유시킨다:
    //   alpha 후보 = [id1(0.000), af×3(0.141), id2(0.765)]   → beta-filler 없음
    //   beta  후보 = [bf×4(0.141),            id2(0.765)]    → id1·alpha-filler 없음
    //   교집합 = {id2} 뿐. id1은 beta 후보에서 밀려나 AND 제외됨을 증명한다.

    // id1 = hotVec(0): alpha 최근접(0), beta 최원거리(√2). beta 후보에서 제외된다 → AND 제외 (핵심).
    const id1 = insertVectoredRecord('alpha only record', 'multi-handler-r1', hotVec(0));

    // id2 = [0.7071,0.7071,...]: alpha/beta 양쪽에 dist≈0.765. 두 후보의 마지막 자리에 모두 든다 → 교집합 포함.
    const intersectVec = Array.from({ length: 384 }, (_, i) =>
      i === 0 ? 0.7071 : i === 1 ? 0.7071 : 0.0,
    );
    const id2 = insertVectoredRecord('both queries record', 'multi-handler-r2', intersectVec);

    // alpha-filler ×3: alpha 후보의 2~4번째 자리를 채워 id2를 5번째로 밀되, beta 후보엔 들지 않는다.
    for (let i = 0; i < 3; i++) {
      insertVectoredRecord(`alpha filler ${i}`, `multi-handler-af-${i}`, alphaFiller(i));
    }
    // beta-filler ×4: beta 후보 1~4번째를 채워 id1을 beta 후보 밖으로 밀어내되, alpha 후보엔 들지 않는다.
    for (let i = 0; i < 4; i++) {
      insertVectoredRecord(`beta filler ${i}`, `multi-handler-bf-${i}`, betaFiller(i));
    }

    // id3: 벡터 없음 → 어떤 vector search에도 등장하지 않음 → 교집합 미포함
    const id3 = insertMemoryRecord(db, {
      kind: 'fact',
      text: 'no vector record',
      archivePath: '/archive/c.jsonl',
      lineStart: 5,
      lineEnd: 6,
      sourceKind: 'claude-projects',
      project: null,
      observedAt: Date.UTC(2026, 4, 26),
      dedupeKey: 'multi-handler-r3',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    void id3;

    const results = await handleSearch({ query: ['alpha', 'beta'], limit: 1 }, db);

    // id2는 두 쿼리 모두에 근접 → 교집합에 포함
    expect(results.some(c => c.id === String(id2))).toBe(true);
    // id1은 alpha에만 가깝고 beta 후보에서 밀려남 → AND 교집합 제외 (핵심)
    expect(results.some(c => c.id === String(id1))).toBe(false);
    // id3는 벡터 없음 → 교집합 미포함
    expect(results.some(c => c.id === String(id3))).toBe(false);
    // 카드 shape 검증
    const card = results.find(c => c.id === String(id2))!;
    expect(typeof card.id).toBe('string');
    expect(card).toHaveProperty('kind');
    expect(card).toHaveProperty('text');
  });

  test('string query → single-search 동작이 그대로 유지된다', async () => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    __setModelForTests(async () => {}, async (_kind: string, _text: string) =>
      Array.from({ length: 384 }, () => 0.1),
    );

    const id = insertMemoryRecord(db, {
      kind: 'fact',
      text: 'string query regression check',
      archivePath: '/archive/d.jsonl',
      lineStart: 1,
      lineEnd: 2,
      sourceKind: 'claude-projects',
      project: null,
      observedAt: Date.UTC(2026, 4, 26),
      dedupeKey: 'string-handler-r1',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertMemoryRecordVector(db, id, Array.from({ length: 384 }, () => 0.1));

    const results = await handleSearch({ query: 'alpha', limit: 10 }, db);

    expect(Array.isArray(results)).toBe(true);
    // 시드한 레코드가 결과에 존재
    expect(results.some(c => c.id === String(id))).toBe(true);
    // id가 문자열인지 확인
    for (const card of results) {
      expect(typeof card.id).toBe('string');
    }
  });
});
