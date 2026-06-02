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

  test('array query → AND intersection: 두 쿼리 모두에 해당하는 카드만 반환한다', async () => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    // "alpha" → hotVec(0), "beta" → hotVec(1), 그 외 → hotVec(2)
    __setModelForTests(async () => {}, async (_kind: string, text: string) => {
      if (text === 'alpha') return hotVec(0);
      if (text === 'beta') return hotVec(1);
      return hotVec(2);
    });

    // id1: hotVec(0) → alpha와 가깝
    const id1 = insertMemoryRecord(db, {
      kind: 'fact',
      text: 'alpha only record',
      archivePath: '/archive/a.jsonl',
      lineStart: 1,
      lineEnd: 2,
      sourceKind: 'claude-projects',
      project: null,
      observedAt: Date.UTC(2026, 4, 26),
      dedupeKey: 'multi-handler-r1',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertMemoryRecordVector(db, id1, hotVec(0));

    // id2: hotVec(2) → alpha/beta 둘 다 비슷하게 멀지만 candidateLimit이 충분히 크면 두 쿼리에 모두 등장
    // 더 확실하게: id2에 두 쿼리가 교차하는 벡터 삽입
    // hotVec(0)+hotVec(1)을 정규화: [1/√2, 1/√2, 0, ...]
    const intersectVec = Array.from({ length: 384 }, (_, i) =>
      i === 0 ? 0.7071 : i === 1 ? 0.7071 : 0.0,
    );
    const id2 = insertMemoryRecord(db, {
      kind: 'event',
      text: 'both queries record',
      archivePath: '/archive/b.jsonl',
      lineStart: 3,
      lineEnd: 4,
      sourceKind: 'claude-projects',
      project: null,
      observedAt: Date.UTC(2026, 4, 26),
      dedupeKey: 'multi-handler-r2',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertMemoryRecordVector(db, id2, intersectVec);

    // id3: 벡터 없음 → 어떤 vector search에도 등장하지 않음
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

    const results = await handleSearch({ query: ['alpha', 'beta'], limit: 10 }, db);

    // id2는 두 쿼리 모두에 근접 → 교집합에 포함
    expect(results.some(c => c.id === String(id2))).toBe(true);
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
    expect(results.length).toBeGreaterThan(0);
    // id가 문자열인지 확인
    for (const card of results) {
      expect(typeof card.id).toBe('string');
    }
  });
});
