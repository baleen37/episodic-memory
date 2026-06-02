# Extraction Retry Backoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 추출 실패 span을 지수 백오프로 재시도하고, 10회 도달 시 영구 포기해 무한 LLM 호출 낭비를 막는다.

**Architecture:** `extraction_state`에 `attempt_count` 컬럼을 추가(기존 DB는 idempotent ALTER로 마이그레이션). indexer의 실패 경로에서 횟수를 증가시키고 `5분 × 2^(n-1)` 백오프를 설정하며, 10회 도달 시 `retry_after=NULL`로 포기한다. 성공 경로는 `attempt_count=0`으로 리셋. `hasPendingRetryExtractionState`에 포기 건 건너뛰기 조건을 추가한다.

**Tech Stack:** TypeScript, bun:sqlite, bun test.

설계 문서: `docs/superpowers/specs/2026-06-02-extraction-retry-backoff-design.md`

---

## File Structure

| 파일 | 책임 | 변경 |
| --- | --- | --- |
| `src/core/db.ts` | 스키마/타입/upsert | 컬럼 추가, idempotent ALTER, `ExtractionStateInsert.attemptCount`, upsert 쿼리, `getExtractionAttemptCount` 헬퍼 |
| `src/core/indexer.ts` | 추출 오케스트레이션 | 백오프 상수, 실패 시 +1/백오프/포기, 성공 시 0 리셋, 포기 건 건너뛰기 |
| `src/core/db.test.ts` 또는 신규 | 단위 테스트 | 마이그레이션, upsert attemptCount, 헬퍼 |
| `src/core/indexer.test.ts` 또는 신규 | 단위 테스트 | 백오프 간격, 포기, 리셋, 건너뛰기 |

기존 테스트 파일 위치는 Task 1에서 확인한다.

---

## Task 0: 기존 테스트 패턴 확인

**Files:**
- Read: `src/core/db.test.ts` (있으면), `src/core/indexer.test.ts` (있으면)

- [ ] **Step 1: 기존 테스트 파일과 패턴 확인**

Run:
```bash
ls src/core/*.test.ts
grep -l "extraction_state\|upsertExtractionState\|initDatabase" src/core/*.test.ts
```

기존 테스트가 `initDatabase()`(in-memory wipe)를 쓰는지, helper import 방식이 무엇인지 확인한다. 이후 Task의 테스트는 이 패턴을 따른다. 테스트 파일이 없으면 신규 생성한다.

Expected: 테스트 파일 목록과 extraction_state를 다루는 기존 테스트 위치.

---

## Task 1: attempt_count 컬럼 + idempotent 마이그레이션

**Files:**
- Modify: `src/core/db.ts` (createSchema, 약 156-175줄)
- Test: `src/core/db.test.ts`

- [ ] **Step 1: 마이그레이션 테스트 작성 (failing)**

`src/core/db.test.ts`에 추가. (import 경로는 Task 0에서 확인한 패턴 사용.)

```ts
import { Database } from 'bun:sqlite';
import { test, expect } from 'bun:test';

// createSchema는 내부 함수이므로, openDatabase 대신 직접 검증이 어렵다면
// 이 테스트는 "신규 스키마에 attempt_count 컬럼이 존재"를 검증한다.
test('extraction_state has attempt_count column with default 0', () => {
  const db = new Database(':memory:');
  // createSchema가 export 안 되어 있으면 Task 1 Step 3에서 export 한다.
  const { createSchemaForTests } = require('./db.ts');
  createSchemaForTests(db);

  const cols = db.query("PRAGMA table_info(extraction_state)").all() as Array<{ name: string; dflt_value: string }>;
  const attempt = cols.find((c) => c.name === 'attempt_count');
  expect(attempt).toBeDefined();
  expect(attempt!.dflt_value).toBe('0');
});

test('migration adds attempt_count to a pre-existing table missing it', () => {
  const db = new Database(':memory:');
  // 옛 스키마(컬럼 없음) 모사
  db.exec(`
    CREATE TABLE extraction_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_kind TEXT NOT NULL, archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
      source_hash TEXT NOT NULL, extraction_version INTEGER NOT NULL,
      status TEXT NOT NULL, error_message TEXT, retry_after INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(archive_path, line_start, line_end, source_hash, extraction_version)
    )
  `);
  const { migrateExtractionStateForTests } = require('./db.ts');
  migrateExtractionStateForTests(db); // 두 번 호출해도 안전해야 함
  migrateExtractionStateForTests(db);

  const cols = db.query("PRAGMA table_info(extraction_state)").all() as Array<{ name: string }>;
  expect(cols.some((c) => c.name === 'attempt_count')).toBe(true);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `bun test src/core/db.test.ts`
Expected: FAIL — `createSchemaForTests`/`migrateExtractionStateForTests`가 export 안 됨.

- [ ] **Step 3: CREATE TABLE에 컬럼 추가 + 마이그레이션 함수 작성**

`src/core/db.ts`의 `extraction_state` CREATE TABLE에서 `retry_after INTEGER,` 다음 줄에 컬럼 추가:

```ts
      retry_after INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
```

그리고 `createSchema` 함수 안, extraction_state 인덱스 생성(`idx_extraction_state_retry_after`) 다음 줄에 마이그레이션 호출 추가:

```ts
  db.exec('CREATE INDEX IF NOT EXISTS idx_extraction_state_retry_after ON extraction_state(retry_after)');
  migrateExtractionState(db);
```

`createSchema` 함수 바로 아래에 마이그레이션 함수와 테스트용 export를 추가:

```ts
function migrateExtractionState(db: Database): void {
  const cols = db
    .query('PRAGMA table_info(extraction_state)')
    .all() as Array<{ name: string }>;
  const hasAttemptCount = cols.some((c) => c.name === 'attempt_count');
  if (!hasAttemptCount) {
    db.exec(
      'ALTER TABLE extraction_state ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0',
    );
  }
}

// Test-only exports
export function createSchemaForTests(db: Database): void {
  createSchema(db);
}
export function migrateExtractionStateForTests(db: Database): void {
  migrateExtractionState(db);
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test src/core/db.test.ts`
Expected: PASS (두 테스트 모두).

- [ ] **Step 5: 커밋**

```bash
git add src/core/db.ts src/core/db.test.ts
git commit -m "feat(db): add attempt_count column with idempotent migration"
```

---

## Task 2: ExtractionStateInsert + upsert에 attemptCount 반영

**Files:**
- Modify: `src/core/db.ts` (ExtractionStateInsert 41-51줄, upsertExtractionState 259-286줄)
- Test: `src/core/db.test.ts`

- [ ] **Step 1: upsert attemptCount 테스트 작성 (failing)**

```ts
test('upsertExtractionState persists attempt_count', () => {
  const db = new Database(':memory:');
  const { createSchemaForTests, upsertExtractionState } = require('./db.ts');
  createSchemaForTests(db);

  upsertExtractionState(db, {
    sourceKind: 'claude-projects', archivePath: '/a.jsonl',
    lineStart: 1, lineEnd: 5, sourceHash: 'h1', extractionVersion: 1,
    status: 'errored', attemptCount: 3, retryAfter: 999,
  });

  const row = db.query(
    'SELECT attempt_count AS attemptCount FROM extraction_state WHERE archive_path = ?'
  ).get('/a.jsonl') as { attemptCount: number };
  expect(row.attemptCount).toBe(3);
});

test('upsertExtractionState defaults attempt_count to 0 when omitted', () => {
  const db = new Database(':memory:');
  const { createSchemaForTests, upsertExtractionState } = require('./db.ts');
  createSchemaForTests(db);

  upsertExtractionState(db, {
    sourceKind: 'claude-projects', archivePath: '/b.jsonl',
    lineStart: 1, lineEnd: 5, sourceHash: 'h1', extractionVersion: 1,
    status: 'done',
  });

  const row = db.query(
    'SELECT attempt_count AS attemptCount FROM extraction_state WHERE archive_path = ?'
  ).get('/b.jsonl') as { attemptCount: number };
  expect(row.attemptCount).toBe(0);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `bun test src/core/db.test.ts`
Expected: FAIL — `attemptCount`가 저장되지 않아 기대값 불일치(또는 타입 에러).

- [ ] **Step 3: 타입과 쿼리 수정**

`ExtractionStateInsert` 인터페이스에 필드 추가 (retryAfter 다음 줄):

```ts
  retryAfter?: number | null;
  attemptCount?: number;
}
```

`upsertExtractionState`의 INSERT 컬럼 목록·VALUES·ON CONFLICT UPDATE·run() 인자를 수정.
현재:

```ts
    INSERT INTO extraction_state (
      source_kind, archive_path, line_start, line_end, source_hash,
      extraction_version, status, error_message, retry_after, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(archive_path, line_start, line_end, source_hash, extraction_version)
    DO UPDATE SET
      source_kind = excluded.source_kind,
      status = excluded.status,
      error_message = excluded.error_message,
      retry_after = excluded.retry_after,
      updated_at = excluded.updated_at
  `).run(
    state.sourceKind,
    state.archivePath,
    state.lineStart,
    state.lineEnd,
    state.sourceHash,
    state.extractionVersion,
    state.status,
    state.errorMessage ?? null,
    state.retryAfter ?? null,
    now,
    now,
  );
```

수정 후:

```ts
    INSERT INTO extraction_state (
      source_kind, archive_path, line_start, line_end, source_hash,
      extraction_version, status, error_message, retry_after, attempt_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(archive_path, line_start, line_end, source_hash, extraction_version)
    DO UPDATE SET
      source_kind = excluded.source_kind,
      status = excluded.status,
      error_message = excluded.error_message,
      retry_after = excluded.retry_after,
      attempt_count = excluded.attempt_count,
      updated_at = excluded.updated_at
  `).run(
    state.sourceKind,
    state.archivePath,
    state.lineStart,
    state.lineEnd,
    state.sourceHash,
    state.extractionVersion,
    state.status,
    state.errorMessage ?? null,
    state.retryAfter ?? null,
    state.attemptCount ?? 0,
    now,
    now,
  );
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test src/core/db.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/core/db.ts src/core/db.test.ts
git commit -m "feat(db): persist attempt_count in upsertExtractionState"
```

---

## Task 3: getExtractionAttemptCount 헬퍼

현재 errored 행의 attempt_count를 읽어 +1 하려면 조회 헬퍼가 필요하다.

**Files:**
- Modify: `src/core/db.ts`
- Test: `src/core/db.test.ts`

- [ ] **Step 1: 헬퍼 테스트 작성 (failing)**

```ts
test('getExtractionAttemptCount returns current count, 0 when missing', () => {
  const db = new Database(':memory:');
  const { createSchemaForTests, upsertExtractionState, getExtractionAttemptCount } = require('./db.ts');
  createSchemaForTests(db);

  // 없는 span → 0
  expect(getExtractionAttemptCount(db, '/x.jsonl', 1, 5, 'h1', 1)).toBe(0);

  upsertExtractionState(db, {
    sourceKind: 'claude-projects', archivePath: '/x.jsonl',
    lineStart: 1, lineEnd: 5, sourceHash: 'h1', extractionVersion: 1,
    status: 'errored', attemptCount: 4, retryAfter: 999,
  });
  expect(getExtractionAttemptCount(db, '/x.jsonl', 1, 5, 'h1', 1)).toBe(4);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `bun test src/core/db.test.ts`
Expected: FAIL — `getExtractionAttemptCount`가 정의되지 않음.

- [ ] **Step 3: 헬퍼 구현**

`src/core/db.ts`의 `upsertExtractionState` 함수 다음에 추가:

```ts
export function getExtractionAttemptCount(
  db: Database,
  archivePath: string,
  lineStart: number,
  lineEnd: number,
  sourceHash: string,
  extractionVersion: number,
): number {
  const row = db.query(`
    SELECT attempt_count AS attemptCount FROM extraction_state
    WHERE archive_path = ? AND line_start = ? AND line_end = ?
      AND source_hash = ? AND extraction_version = ?
  `).get(archivePath, lineStart, lineEnd, sourceHash, extractionVersion) as
    | { attemptCount: number }
    | null;
  return row?.attemptCount ?? 0;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test src/core/db.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/core/db.ts src/core/db.test.ts
git commit -m "feat(db): add getExtractionAttemptCount helper"
```

---

## Task 4: 백오프 계산 함수 (indexer)

**Files:**
- Modify: `src/core/indexer.ts`
- Test: `src/core/indexer.test.ts`

- [ ] **Step 1: 백오프 계산 테스트 작성 (failing)**

`src/core/indexer.test.ts`에 추가 (import 경로는 Task 0 패턴 사용):

```ts
import { test, expect } from 'bun:test';
import { computeRetryAfter, ATTEMPT_CAP, BASE_DELAY_MS } from './indexer.ts';

test('computeRetryAfter: exponential 5min base, doubling', () => {
  const now = 1_000_000;
  expect(computeRetryAfter(1, now)).toBe(now + 5 * 60 * 1000);        // 5분
  expect(computeRetryAfter(2, now)).toBe(now + 10 * 60 * 1000);       // 10분
  expect(computeRetryAfter(3, now)).toBe(now + 20 * 60 * 1000);       // 20분
  expect(computeRetryAfter(4, now)).toBe(now + 40 * 60 * 1000);       // 40분
});

test('computeRetryAfter: returns null at or above attempt cap (give up)', () => {
  const now = 1_000_000;
  expect(ATTEMPT_CAP).toBe(10);
  expect(computeRetryAfter(ATTEMPT_CAP, now)).toBeNull();
  expect(computeRetryAfter(ATTEMPT_CAP + 1, now)).toBeNull();
});

test('BASE_DELAY_MS is 5 minutes', () => {
  expect(BASE_DELAY_MS).toBe(5 * 60 * 1000);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `bun test src/core/indexer.test.ts`
Expected: FAIL — `computeRetryAfter`/`ATTEMPT_CAP`/`BASE_DELAY_MS` 미정의.

- [ ] **Step 3: 상수와 함수 구현**

`src/core/indexer.ts` 상단(import 다음, 다른 상수 근처)에 추가:

```ts
export const BASE_DELAY_MS = 5 * 60 * 1000; // 5분
export const ATTEMPT_CAP = 10;

/**
 * 지수 백오프 다음 재시도 시각. attemptCount는 이번 실패까지 포함한 누적 횟수.
 * attemptCount >= ATTEMPT_CAP 이면 포기 의미로 null 반환(retry_after=NULL).
 */
export function computeRetryAfter(attemptCount: number, now: number): number | null {
  if (attemptCount >= ATTEMPT_CAP) {
    return null;
  }
  const delay = BASE_DELAY_MS * 2 ** (attemptCount - 1);
  return now + delay;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test src/core/indexer.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/core/indexer.ts src/core/indexer.test.ts
git commit -m "feat(indexer): add exponential backoff computeRetryAfter"
```

---

## Task 5: 실패 경로에 백오프/포기 적용 + 성공 시 리셋

**Files:**
- Modify: `src/core/indexer.ts` (catch 블록 260-273줄, 성공 upsert 212-220 및 242-250줄)
- Test: `src/core/indexer.test.ts` (Task 6에서 통합 검증; 여기선 컴파일/기존 테스트 회귀 확인)

- [ ] **Step 1: import 추가**

`src/core/indexer.ts`에서 `db.ts`로부터 `getExtractionAttemptCount`를 import 한다.
기존 db import 라인에 추가:

```ts
import { getExtractionAttemptCount } from './db.js';
```

(기존 import 스타일이 `from './db.js'`인지 `'./db'`인지 Task 0/파일 상단에서 확인해 맞춘다.)

- [ ] **Step 2: catch 블록 수정**

현재 catch 블록 (260-273줄):

```ts
    } catch (error) {
      upsertExtractionState(db, {
        sourceKind: span.sourceKind,
        archivePath: span.archivePath,
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
        sourceHash,
        extractionVersion: CURRENT_EXTRACTION_VERSION,
        status: 'errored',
        errorMessage: error instanceof Error ? error.message : String(error),
        retryAfter: Date.now() + 60 * 60 * 1000,
      });
      result.spansErrored++;
    }
```

수정 후:

```ts
    } catch (error) {
      const now = Date.now();
      const prevAttempts = getExtractionAttemptCount(
        db,
        span.archivePath,
        span.lineStart,
        span.lineEnd,
        sourceHash,
        CURRENT_EXTRACTION_VERSION,
      );
      const attemptCount = prevAttempts + 1;
      upsertExtractionState(db, {
        sourceKind: span.sourceKind,
        archivePath: span.archivePath,
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
        sourceHash,
        extractionVersion: CURRENT_EXTRACTION_VERSION,
        status: 'errored',
        errorMessage: error instanceof Error ? error.message : String(error),
        attemptCount,
        retryAfter: computeRetryAfter(attemptCount, now),
      });
      result.spansErrored++;
    }
```

- [ ] **Step 3: 성공 경로에 attemptCount 0 리셋 명시**

성공 upsert 두 곳(`status: 'empty'` ~212줄, `status: 'done'` ~242줄)에 `attemptCount: 0`을 추가한다.

`status: 'empty'` 블록:

```ts
          upsertExtractionState(db, {
            sourceKind: span.sourceKind,
            archivePath: span.archivePath,
            lineStart: span.lineStart,
            lineEnd: span.lineEnd,
            sourceHash,
            extractionVersion: CURRENT_EXTRACTION_VERSION,
            status: 'empty',
            attemptCount: 0,
          });
```

`status: 'done'` 블록:

```ts
        upsertExtractionState(db, {
          sourceKind: span.sourceKind,
          archivePath: span.archivePath,
          lineStart: span.lineStart,
          lineEnd: span.lineEnd,
          sourceHash,
          extractionVersion: CURRENT_EXTRACTION_VERSION,
          status: 'done',
          attemptCount: 0,
        });
```

(참고: upsert 기본값이 0이라 명시 안 해도 결과는 같지만, 재시도 후 성공 시 명시적 리셋 의도를 코드로 드러낸다.)

- [ ] **Step 4: 타입체크 + 기존 테스트 회귀 확인**

Run:
```bash
bun run typecheck
bun test src/core/indexer.test.ts
```
Expected: 타입 PASS, 기존 indexer 테스트 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/core/indexer.ts
git commit -m "feat(indexer): apply exponential backoff and attempt cap on extraction failure"
```

---

## Task 6: 포기 건 건너뛰기 (hasPendingRetryExtractionState)

**Files:**
- Modify: `src/core/indexer.ts` (hasPendingRetryExtractionState 110-125줄)
- Test: `src/core/indexer.test.ts`

- [ ] **Step 1: 건너뛰기 테스트 작성 (failing)**

```ts
import { Database } from 'bun:sqlite';
import { createSchemaForTests, upsertExtractionState } from './db.ts';
import { hasPendingRetryExtractionStateForTests } from './indexer.ts';

test('given-up span (attempt_count>=cap, retry_after null) is skipped', () => {
  const db = new Database(':memory:');
  createSchemaForTests(db);

  upsertExtractionState(db, {
    sourceKind: 'claude-projects', archivePath: '/g.jsonl',
    lineStart: 1, lineEnd: 5, sourceHash: 'h1', extractionVersion: 1,
    status: 'errored', attemptCount: 10, retryAfter: null,
  });

  expect(
    hasPendingRetryExtractionStateForTests(db, '/g.jsonl', 1, 5, 'h1', 1),
  ).toBe(true); // true = 건너뜀
});

test('errored span still within backoff window is skipped', () => {
  const db = new Database(':memory:');
  createSchemaForTests(db);

  upsertExtractionState(db, {
    sourceKind: 'claude-projects', archivePath: '/w.jsonl',
    lineStart: 1, lineEnd: 5, sourceHash: 'h1', extractionVersion: 1,
    status: 'errored', attemptCount: 2, retryAfter: Date.now() + 60_000,
  });

  expect(
    hasPendingRetryExtractionStateForTests(db, '/w.jsonl', 1, 5, 'h1', 1),
  ).toBe(true);
});

test('errored span past backoff window (not given up) is NOT skipped', () => {
  const db = new Database(':memory:');
  createSchemaForTests(db);

  upsertExtractionState(db, {
    sourceKind: 'claude-projects', archivePath: '/r.jsonl',
    lineStart: 1, lineEnd: 5, sourceHash: 'h1', extractionVersion: 1,
    status: 'errored', attemptCount: 2, retryAfter: Date.now() - 60_000,
  });

  expect(
    hasPendingRetryExtractionStateForTests(db, '/r.jsonl', 1, 5, 'h1', 1),
  ).toBe(false); // false = 재시도 대상
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `bun test src/core/indexer.test.ts`
Expected: FAIL — `hasPendingRetryExtractionStateForTests` 미정의, 그리고 포기 건 테스트가 false 반환(현재 로직).

- [ ] **Step 3: 쿼리에 포기 조건 추가 + 테스트 export**

현재 `hasPendingRetryExtractionState` (110-125줄):

```ts
function hasPendingRetryExtractionState(
  db: Database,
  archivePath: string,
  lineStart: number,
  lineEnd: number,
  sourceHash: string,
  extractionVersion: number,
): boolean {
  const row = db.query(`
    SELECT retry_after AS retryAfter FROM extraction_state
    WHERE archive_path = ? AND line_start = ? AND line_end = ?
      AND source_hash = ? AND extraction_version = ? AND status = 'errored'
      AND retry_after IS NOT NULL AND retry_after > ?
  `).get(archivePath, lineStart, lineEnd, sourceHash, extractionVersion, Date.now()) as { retryAfter: number } | null;
  return row !== null;
}
```

수정 후 — "아직 백오프 대기 중" OR "포기 건"이면 건너뛴다:

```ts
function hasPendingRetryExtractionState(
  db: Database,
  archivePath: string,
  lineStart: number,
  lineEnd: number,
  sourceHash: string,
  extractionVersion: number,
): boolean {
  const row = db.query(`
    SELECT 1 AS one FROM extraction_state
    WHERE archive_path = ? AND line_start = ? AND line_end = ?
      AND source_hash = ? AND extraction_version = ? AND status = 'errored'
      AND (
        (retry_after IS NOT NULL AND retry_after > ?)
        OR attempt_count >= ?
      )
  `).get(
    archivePath, lineStart, lineEnd, sourceHash, extractionVersion,
    Date.now(), ATTEMPT_CAP,
  ) as { one: number } | null;
  return row !== null;
}

// Test-only export
export function hasPendingRetryExtractionStateForTests(
  db: Database,
  archivePath: string,
  lineStart: number,
  lineEnd: number,
  sourceHash: string,
  extractionVersion: number,
): boolean {
  return hasPendingRetryExtractionState(
    db, archivePath, lineStart, lineEnd, sourceHash, extractionVersion,
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test src/core/indexer.test.ts`
Expected: PASS (3개 모두).

- [ ] **Step 5: 커밋**

```bash
git add src/core/indexer.ts
git commit -m "feat(indexer): skip given-up spans in retry gate"
```

---

## Task 7: 전체 검증 + 빌드

**Files:** 없음 (검증만)

- [ ] **Step 1: 전체 테스트**

Run: `bun test`
Expected: 전부 PASS, 회귀 없음.

- [ ] **Step 2: 타입체크**

Run: `bun run typecheck`
Expected: 에러 없음.

- [ ] **Step 3: 빌드 (런타임 번들 갱신)**

Run: `bun run build`
Expected: 성공. (CLAUDE.md: TS 변경 후 재빌드 필요.)

- [ ] **Step 4: 최종 커밋 (빌드 산출물이 추적된다면)**

```bash
git status
# dist/ 가 추적 대상이면:
git add dist/
git commit -m "build: rebuild bundles for extraction retry backoff"
# 추적 안 하면 이 스텝 생략
```

---

## Self-Review 결과

- **Spec coverage**: 컬럼 추가/마이그레이션(Task1) ✅, upsert attemptCount(Task2) ✅, 헬퍼(Task3) ✅, 지수 백오프(Task4) ✅, 실패 +1·백오프·포기(Task5) ✅, 성공 리셋(Task5 Step3) ✅, 포기 건 건너뛰기(Task6) ✅, verify.ts 수정 없음(spec 명시, 검증은 Task7 전체 테스트로 회귀 확인) ✅.
- **Placeholder**: 없음. 모든 코드 스텝에 실제 코드 포함.
- **Type consistency**: `ATTEMPT_CAP=10`, `BASE_DELAY_MS=5*60*1000`, `computeRetryAfter(attemptCount, now)`, `attemptCount` 필드명, `getExtractionAttemptCount` 시그니처가 Task 전반에서 일치.
- **주의(실행자용)**: import 확장자(`./db.js` vs `./db.ts`)와 기존 test import 스타일은 Task 0에서 확인해 맞출 것. `createSchema`가 export 안 되어 있어 test-only export(`createSchemaForTests` 등)를 추가하는 방식 사용.
