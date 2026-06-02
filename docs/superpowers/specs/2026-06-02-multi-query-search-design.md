# Multi-Query (Multi-Concept AND) Search — Design

Date: 2026-06-02

## 목적

긴 단일 쿼리를 통째로 검색하는 것보다, 의미 단위로 쪼갠 여러 검색어로 각각 벡터 검색한 뒤
**모든 검색어에 공통으로 걸리는 메모리 레코드만** 추리는 편이 정밀도(precision)가 높다.
obra/episodic-memory의 multi-concept AND search 동작을 memmem 단위(memory_record)에 맞춰 차용한다.

## 동작 (obra `src/search.ts:320-378` 차용)

`search` 도구의 `query`를 `string | string[]`로 확장한다.

- **string** → 기존 동작 100% 유지 (벡터 우선 + 텍스트 폴백 + dedupe). 하위호환.
- **string[] (길이 2~5)** → multi-query AND:
  1. 각 검색어를 독립적으로 벡터 검색한다. 후보는 넉넉히 `limit * 5`, **mode는 벡터 고정** (텍스트 폴백 없음 — obra와 동일).
  2. 결과를 **memory_record id** 기준으로 그룹화한다.
  3. **모든 검색어에 등장한 id만** 남긴다 (AND 교집합). 한 검색어라도 빠지면 탈락.
  4. 살아남은 레코드의 score = 검색어별 score의 **평균(mean)** (obra와 동일).
  5. 평균 score 내림차순 정렬 후 `limit`개로 자른다.
- **길이 1 배열** → string과 동일하게 단일 검색으로 처리.

반환 카드 포맷은 기존 compact card(`id`, `kind`, `text`, `score`)와 동일. surface 변화는 입력 타입뿐.

## 손대는 곳

| 파일 | 변경 |
| ---- | ---- |
| `src/core/search.ts` | `searchMulti(queries, options)` 추가 — per-query 벡터 검색 → id 그룹화 → AND 교집합 → 평균 score → 정렬/슬라이스. 기존 `search()`/`vectorSearch()` 재사용. |
| `src/mcp/schemas.ts` | `query`를 `z.union([z.string().min(2), z.array(z.string().min(2)).min(2).max(5)])`로 확장. |
| `src/mcp/tools.ts` | `query` JSON Schema를 `anyOf: [string, {type: array, items: string, minItems: 2, maxItems: 5}]`로. description에 multi-query AND 설명 추가. |
| `src/mcp/handlers.ts` | 배열이면 `searchMulti`, 아니면 기존 `search` 호출로 분기. |
| `src/cli/search.ts` (+ `main.ts`) | `--query`를 반복 지정하거나 콤마 분리로 여러 개 받을 수 있게. CLI는 선택적 — MCP가 1차 surface. |

## 경계 / 엣지

- 길이 1 배열 → 단일 검색 (특수 분기).
- 교집합이 비면 빈 배열 반환 (에러 아님).
- 배열 길이 6 이상 또는 빈 문자열 → 스키마에서 검증 실패.
- 각 검색어 임베딩은 N번 호출 (검색어 수만큼). N≤5이므로 비용 bounded.

## 테스트 (TDD)

`src/core/search.test.ts`에 추가:

1. 두 검색어 모두에 걸리는 레코드만 반환 (AND 교집합 검증).
2. 한 검색어에만 걸린 레코드는 제외.
3. score가 검색어별 score의 평균인지 검증.
4. 평균 score 내림차순 정렬 검증.
5. 길이 1 배열은 단일 검색과 동일 결과.
6. 교집합 없으면 빈 배열.

`src/mcp/handlers.test.ts` (있으면):
7. 배열 query 입력 시 searchMulti로 분기, 카드 포맷 동일.

mock 임베딩(`__setModelForTests()`)으로 네트워크 없이 검증.

## YAGNI

- score 합산 방식 설정화(min/max/mean 선택) — 안 함. obra대로 mean 고정.
- multi-query 텍스트 폴백 — 안 함. obra대로 벡터 고정.
- conversation 단위 그룹화 — memmem은 record 단위이므로 record id로 그룹화.
