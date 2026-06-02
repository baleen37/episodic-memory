# Multi-Query (Multi-Concept AND) Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `search`에 여러 검색어 배열을 받아, 모든 검색어에 공통으로 걸리는 메모리 레코드만 평균 score 순으로 반환하는 multi-query AND 검색을 추가한다.

**Architecture:** `src/core/search.ts`에 `searchMulti(queries, options)`를 추가한다. 각 검색어를 기존 `vectorSearch`로 `limit*5` 후보까지 독립 검색하고, memory_record id로 그룹화해 모든 검색어에 등장한 id만(AND 교집합) 남긴 뒤, 검색어별 score 평균으로 정렬해 limit개 반환한다. MCP/CLI surface는 `query`를 `string | string[]`로 확장하고, 배열이면 `searchMulti`로 분기한다. string 경로는 기존 `search`를 그대로 호출해 하위호환을 유지한다.

**Tech Stack:** Bun, TypeScript, bun:sqlite, sqlite-vec, zod, `@modelcontextprotocol/sdk`, bun test.

---

## File Structure

| 파일 | 책임 | 변경 |
| ---- | ---- | ---- |
| `src/core/search.ts` | 검색 코어 | `searchMulti()` 추가 (기존 `vectorSearch`/`validateISODate` 재사용) |
| `src/core/search.test.ts` | 코어 테스트 | `searchMulti` 동작 테스트 추가 |
| `src/mcp/schemas.ts` | MCP 입력 검증 | `query`를 string ∪ string[](2~5) union으로 |
| `src/mcp/tools.ts` | MCP 도구 정의 | `query` JSON Schema를 anyOf로, description 보강 |
| `src/mcp/handlers.ts` | MCP 핸들러 | 배열이면 `searchMulti`, 아니면 `search`로 분기 |
| `src/mcp/handlers.test.ts` | 핸들러 테스트 (없으면 생성) | 배열 query 분기 + 카드 포맷 테스트 |

CLI는 이번 plan 범위에서 제외(MCP가 1차 surface). 필요 시 후속 plan으로 분리.

---

### Task 1: `searchMulti` 코어 — 테스트 먼저

**Files:**
- Modify: `src/core/search.ts`
- Test: `src/core/search.test.ts`

기존 테스트 파일의 mock 임베딩 설정 패턴을 먼저 확인한다. `src/core/search.test.ts` 상단에서 `__setModelForTests`(또는 동등 mock) 사용법과 DB 시드 헬퍼를 그대로 따른다.

- [ ] **Step 1: 기존 테스트 파일의 setup 패턴 확인**

Run: `bun test src/core/search.test.ts 2>&1 | tail -20`
Expected: PASS (현 상태). 이후 같은 파일에 테스트를 추가한다. 파일 상단의 import, `__setModelForTests`, DB 시드 방식을 읽어 그대로 재사용한다.

- [ ] **Step 2: AND 교집합 + 평균 score 실패 테스트 작성**

`src/core/search.test.ts`에 추가. 기존 파일의 DB 시드/모델 mock 헬퍼 이름에 맞춰 `seedRecord`/`setMockEmbeddings` 부분을 실제 헬퍼로 치환한다(아래는 의도를 보여주는 코드 — 헬퍼 이름은 기존 파일 것으로 맞출 것).

```ts
import { searchMulti } from './search.js';

test('searchMulti returns only records matching ALL queries (AND intersection)', async () => {
  // 기존 파일의 시드 헬퍼로 레코드 3개를 넣는다:
  //   id=1: 검색어A에만 강하게 매칭
  //   id=2: 검색어A·B 둘 다 매칭   <- 유일하게 살아남아야 함
  //   id=3: 검색어B에만 매칭
  // 기존 파일의 모델 mock으로 검색어별 임베딩을 위 매칭이 나오도록 고정한다.
  const results = await searchMulti(['queryA', 'queryB'], { db, limit: 10 });
  expect(results.map(r => r.id)).toEqual([2]);
});

test('searchMulti scores each surviving record as the mean of per-query scores', async () => {
  // id=2가 queryA에서 score sA, queryB에서 score sB로 나오도록 mock.
  const results = await searchMulti(['queryA', 'queryB'], { db, limit: 10 });
  const rec = results.find(r => r.id === 2)!;
  // sA, sB는 mock distance로부터 1/(1+distance)로 계산되는 값.
  // 테스트에서는 vectorSearch를 한 번씩 직접 호출해 기대 평균을 산출하거나,
  // mock distance를 고정값으로 두고 (sA+sB)/2 를 직접 계산해 비교한다.
  expect(rec.score).toBeCloseTo(expectedMean, 5);
});

test('searchMulti sorts by mean score descending and respects limit', async () => {
  const results = await searchMulti(['queryA', 'queryB'], { db, limit: 2 });
  expect(results.length).toBeLessThanOrEqual(2);
  for (let i = 1; i < results.length; i++) {
    expect(results[i - 1].score!).toBeGreaterThanOrEqual(results[i].score!);
  }
});

test('searchMulti returns empty array when intersection is empty', async () => {
  // 어떤 레코드도 모든 검색어에 동시에 걸리지 않도록 mock.
  const results = await searchMulti(['queryA', 'queryB'], { db, limit: 10 });
  expect(results).toEqual([]);
});

test('searchMulti with a single-element array behaves like single-query search', async () => {
  const multi = await searchMulti(['queryA'], { db, limit: 10 });
  const single = await search('queryA', { db, limit: 10 });
  expect(multi.map(r => r.id)).toEqual(single.map(r => r.id));
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `bun test src/core/search.test.ts 2>&1 | tail -20`
Expected: FAIL — `searchMulti` is not exported / not a function.

- [ ] **Step 4: `searchMulti` 구현**

`src/core/search.ts`의 `search()` 함수 바로 아래(파일 끝, line 283 이후)에 추가:

```ts
export async function searchMulti(
  queries: string[],
  options: SearchOptions
): Promise<MemorySearchResult[]> {
  const { limit = 10, after, before } = options;

  if (after) validateISODate(after, '--after');
  if (before) validateISODate(before, '--before');

  if (queries.length === 1) {
    return search(queries[0], options);
  }

  // 각 검색어를 넉넉한 후보로 독립 벡터 검색 (텍스트 폴백 없음 — 벡터 고정).
  const candidateLimit = limit * 5;
  const perQuery = await Promise.all(
    queries.map(query => vectorSearch(query, { ...options, limit: candidateLimit })),
  );

  // memory_record id -> 검색어별 결과 모음.
  const byId = new Map<number, { record: MemorySearchResult; scores: number[] }>();
  perQuery.forEach(results => {
    for (const result of results) {
      const entry = byId.get(result.id);
      const score = result.score ?? 0;
      if (entry) {
        entry.scores.push(score);
      } else {
        byId.set(result.id, { record: result, scores: [score] });
      }
    }
  });

  // 모든 검색어에 등장한 id만 (AND 교집합).
  const intersected: MemorySearchResult[] = [];
  for (const { record, scores } of byId.values()) {
    if (scores.length === queries.length) {
      const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
      intersected.push({ ...record, score: mean });
    }
  }

  intersected.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return intersected.slice(0, limit);
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `bun test src/core/search.test.ts 2>&1 | tail -20`
Expected: PASS (Task 1의 5개 테스트 포함 전체 통과).

- [ ] **Step 6: 커밋**

```bash
git add src/core/search.ts src/core/search.test.ts
git commit -m "feat(search): add searchMulti for multi-query AND search"
```

---

### Task 2: MCP 스키마 — query를 string ∪ string[] union으로

**Files:**
- Modify: `src/mcp/schemas.ts`
- Test: `src/mcp/schemas.test.ts` (없으면 생성)

- [ ] **Step 1: 스키마 검증 실패 테스트 작성**

`src/mcp/schemas.test.ts`에 추가(파일 없으면 생성):

```ts
import { test, expect } from 'bun:test';
import { SearchInputSchema } from './schemas.js';

test('SearchInputSchema accepts a string query', () => {
  const parsed = SearchInputSchema.parse({ query: 'hello' });
  expect(parsed.query).toBe('hello');
});

test('SearchInputSchema accepts an array of 2-5 query strings', () => {
  const parsed = SearchInputSchema.parse({ query: ['a', 'bb'] });
  expect(parsed.query).toEqual(['a', 'bb']);
});

test('SearchInputSchema rejects an array with fewer than 2 items', () => {
  expect(() => SearchInputSchema.parse({ query: ['only-one'] })).toThrow();
});

test('SearchInputSchema rejects an array with more than 5 items', () => {
  expect(() => SearchInputSchema.parse({ query: ['1', '2', '3', '4', '5', '6'] })).toThrow();
});

test('SearchInputSchema rejects an array containing a too-short string', () => {
  expect(() => SearchInputSchema.parse({ query: ['ok', 'x'] })).toThrow();
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `bun test src/mcp/schemas.test.ts 2>&1 | tail -20`
Expected: FAIL — 배열 입력에서 string 단일 스키마가 거부됨.

- [ ] **Step 3: 스키마 수정**

`src/mcp/schemas.ts`의 `query` 필드를 union으로 교체:

```ts
export const SearchInputSchema = z.object({
  query: z.union([
    z.string().min(2),
    z.array(z.string().min(2)).min(2).max(5),
  ]),
  limit: z.number().int().min(1).max(50).default(10),
  after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
```

`SearchInput`/`FetchInput` 타입 export(line 14-15)는 그대로 둔다 — `z.infer`가 union을 자동 반영한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test src/mcp/schemas.test.ts 2>&1 | tail -20`
Expected: PASS (5개 모두).

- [ ] **Step 5: 커밋**

```bash
git add src/mcp/schemas.ts src/mcp/schemas.test.ts
git commit -m "feat(mcp): accept string or 2-5 string array for search query"
```

---

### Task 3: MCP 핸들러 — 배열이면 searchMulti로 분기

**Files:**
- Modify: `src/mcp/handlers.ts:13-30`
- Test: `src/mcp/handlers.test.ts` (없으면 생성)

- [ ] **Step 1: 분기 동작 실패 테스트 작성**

`src/mcp/handlers.test.ts`에 추가(없으면 생성). DB 시드/모델 mock은 `src/core/search.test.ts`의 패턴을 그대로 가져온다.

```ts
import { test, expect } from 'bun:test';
import { handleSearch } from './handlers.js';
// + 기존 search.test.ts와 동일한 db 시드/모델 mock import

test('handleSearch with array query returns AND-intersection cards', async () => {
  // id=2만 두 검색어 모두에 매칭되도록 시드/mock (Task 1과 동일 구도).
  const cards = await handleSearch({ query: ['queryA', 'queryB'], limit: 10 }, db);
  expect(cards.map(c => c.id)).toEqual(['2']);
  // 카드 포맷은 단일 검색과 동일: id(string), kind, text, score?
  expect(cards[0]).toHaveProperty('kind');
  expect(cards[0]).toHaveProperty('text');
});

test('handleSearch with string query keeps single-search behavior', async () => {
  const cards = await handleSearch({ query: 'queryA', limit: 10 }, db);
  expect(Array.isArray(cards)).toBe(true);
  if (cards.length > 0) expect(typeof cards[0].id).toBe('string');
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `bun test src/mcp/handlers.test.ts 2>&1 | tail -20`
Expected: FAIL — 배열 query가 `search()`로 전달돼 타입/동작 불일치.

- [ ] **Step 3: 핸들러 분기 구현**

`src/mcp/handlers.ts` 상단 import에 `searchMulti` 추가하고(line 2), `handleSearch`(line 13-30)를 다음으로 교체:

```ts
import { search, searchMulti, getMemoryRecordLocation } from '../core/search.js';
```

```ts
export async function handleSearch(params: SearchInput, db: Database): Promise<SearchResult[]> {
  const options = {
    db,
    limit: params.limit,
    after: params.after,
    before: params.before,
  };
  const results = Array.isArray(params.query)
    ? await searchMulti(params.query, options)
    : await search(params.query, options);

  return results.map(result => {
    const card: SearchResult = {
      id: String(result.id),
      kind: result.kind,
      text: result.text,
    };
    if (result.score !== undefined) card.score = Math.round(result.score * 1000) / 1000;
    return card;
  });
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test src/mcp/handlers.test.ts 2>&1 | tail -20`
Expected: PASS (2개).

- [ ] **Step 5: 커밋**

```bash
git add src/mcp/handlers.ts src/mcp/handlers.test.ts
git commit -m "feat(mcp): route array query to searchMulti in handleSearch"
```

---

### Task 4: MCP 도구 정의 — query JSON Schema를 anyOf로

**Files:**
- Modify: `src/mcp/tools.ts:9-13` (query property), `src/mcp/tools.ts:5` (description)

- [ ] **Step 1: query 스키마를 anyOf로 교체**

`src/mcp/tools.ts`의 `searchTool.inputSchema.properties.query`(line 9-13)를 교체:

```ts
      query: {
        anyOf: [
          { type: 'string', minLength: 2 },
          { type: 'array', items: { type: 'string', minLength: 2 }, minItems: 2, maxItems: 5 },
        ],
        description: 'Search query. A single string for normal search, or an array of 2-5 strings for multi-query AND search (returns only records matching ALL queries, scored by mean similarity).',
      },
```

- [ ] **Step 2: 도구 description 보강**

`src/mcp/tools.ts`의 `searchTool.description`(line 5)을 교체:

```ts
  description: 'Search indexed event/fact memory records. Pass a single query string, or an array of 2-5 query strings for multi-query AND search (only records matching every query, ranked by mean similarity). Returns compact memory cards (id, kind, text, score). Call the fetch tool with a result id to read the full source transcript.',
```

- [ ] **Step 3: 타입 컴파일 확인**

Run: `bun run typecheck 2>&1 | tail -20`
Expected: 에러 없음 (`tsc --noEmit` 통과).

- [ ] **Step 4: 커밋**

```bash
git add src/mcp/tools.ts
git commit -m "feat(mcp): document multi-query array in search tool schema"
```

---

### Task 5: 전체 검증 + 빌드

**Files:** 없음 (검증 전용)

- [ ] **Step 1: 전체 테스트**

Run: `bun test 2>&1 | tail -20`
Expected: 전체 PASS, 신규 테스트 포함.

- [ ] **Step 2: 타입체크**

Run: `bun run typecheck 2>&1 | tail -20`
Expected: 에러 없음.

- [ ] **Step 3: 빌드**

Run: `bun run build 2>&1 | tail -20`
Expected: dist 번들 성공 (CLAUDE.md: 런타임 wrapper/TS 변경 후 재빌드 필요).

- [ ] **Step 4: MCP 실제 동작 스모크 (선택)**

빌드된 MCP 서버 또는 코어를 통해 배열 query가 AND 교집합 결과를 반환하는지 1회 확인한다(실데이터 기준이라 결과는 환경 의존 — 에러 없이 카드가 반환되면 통과).

- [ ] **Step 5: 커밋 (빌드 산출물 정책에 따라)**

dist를 커밋하는 저장소 관행이면:

```bash
git add dist
git commit -m "build: rebuild dist with multi-query search"
```

dist가 .gitignore면 이 단계 생략.

---

## Self-Review

**Spec coverage:**
- query string|string[](2~5) → Task 2(schema)·Task 4(tool)·Task 3(handler 분기). ✅
- per-query 벡터 검색 `limit*5`, 벡터 고정 → Task 1 `searchMulti`. ✅
- record id 그룹화 + AND 교집합 → Task 1. ✅
- score 평균(mean) → Task 1 + 테스트. ✅
- 평균 내림차순 정렬 + limit → Task 1 + 테스트. ✅
- string 하위호환 → Task 1(length===1, search 위임)·Task 3(분기). ✅
- 길이 1 배열 = 단일 검색 → Task 1 `if (queries.length === 1)` + 테스트. ✅
- 교집합 빈 결과 → Task 1 + 테스트. ✅

**Placeholder scan:** Task 1·3 테스트의 시드/mock 헬퍼는 "기존 `search.test.ts` 패턴 사용"으로 위임 — 실제 헬퍼 이름은 Step 1에서 파일을 읽어 확정. 이는 placeholder가 아니라 기존 코드 재사용 지시. 그 외 모든 구현 코드는 완전 기재됨.

**Type consistency:** `searchMulti(queries: string[], options: SearchOptions): Promise<MemorySearchResult[]>` — Task 1 정의와 Task 3 호출부 시그니처 일치. `SearchResult` 카드 포맷(id:string, kind, text, score?)은 기존 handler와 동일. `SearchInput.query`는 union, handler에서 `Array.isArray`로 분기 — 타입 일관.
