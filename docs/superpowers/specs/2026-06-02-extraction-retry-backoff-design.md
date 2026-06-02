# Extraction Retry: Exponential Backoff + Attempt Cap

날짜: 2026-06-02

## 배경

`extraction_state`는 LLM 추출에 실패한 transcript span을 `status='errored'`로 표시하고
`retry_after = now + 1시간`을 설정한다. 다음 sync에서 1시간이 지났으면 다시 시도한다.

문제: **재시도 횟수 상한이 없다.** `retry_after`(시각)만 있고 시도 횟수를 세는 컬럼이 없어,
영구적으로 실패하는 span(예: 항상 파싱이 깨지는 내용)은 매시간 무한히 LLM을 호출하며
쿼터/비용을 낭비한다.

관찰된 실패의 대부분은 Google `gemma-4-31b-it` 모델의 일시적 `500 Internal Server Error` /
`503 Service Unavailable`이며, round-robin provider가 다른 모델로 폴백해 대체로 복구된다.
하지만 round-robin의 모든 엔트리가 실패하면 span이 errored로 남고 무한 재시도 대상이 된다.

## 목표

- 일시적 장애(500/503)는 **짧은 간격**으로 빠르게 재시도해 복구한다.
- 만성 실패 span은 **간격을 점점 늘리다가 횟수 상한에서 포기**해 호출 낭비를 막는다.
- 스키마 변경을 최소화하고, 기존 DB에 안전하게 적용한다.

## 비목표

- round-robin provider 동작 변경 (그대로 둠).
- LLM provider 추가/교체.
- 시간 기반 상한(예: "48시간 경과 시 포기"). 횟수 상한으로 단순화한다.

## 설계

### 1. 데이터 모델

`extraction_state`에 컬럼 하나 추가:

```sql
attempt_count INTEGER NOT NULL DEFAULT 0
```

- `done` / `empty` 상태: 의미 없음 (성공 시 0으로 리셋).
- `errored` 상태: 실패할 때마다 +1.

#### 마이그레이션

이 프로젝트는 마이그레이션 시스템 없이 `CREATE TABLE IF NOT EXISTS`만 사용한다.
`IF NOT EXISTS`는 테이블이 통째로 없을 때만 작동하므로, 이미 `extraction_state` 테이블이
있는 기존 DB에는 새 컬럼이 추가되지 않는다.

해결: `openDatabase()`에서 idempotent하게 컬럼을 추가한다.

1. `CREATE TABLE` 정의에 `attempt_count` 포함 (신규 DB용).
2. 테이블 생성 직후, `PRAGMA table_info(extraction_state)`로 현재 컬럼 목록을 읽는다.
3. `attempt_count`가 없으면 `ALTER TABLE extraction_state ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0` 실행.
4. 있으면 건너뛴다.

이러면 신규/기존 DB 모두에서, 여러 번 실행해도 안전하다.

### 2. 백오프 + 포기 로직 (indexer.ts catch 블록)

추출 실패 시:

1. `attempt_count`를 1 증가시킨다 (`next = prev + 1`).
2. **포기 판정**: `next >= ATTEMPT_CAP`(=10)이면 `retry_after = NULL`로 설정해 영구 포기.
3. 아직 상한 미만이면 지수 백오프로 다음 시각 계산:

   ```
   delayMs = BASE_DELAY_MS(5분) * 2^(next - 1)
   retry_after = now + delayMs
   ```

간격 표:

| attempt_count | delay | 비고 |
| --- | --- | --- |
| 1 | 5분 | |
| 2 | 10분 | |
| 3 | 20분 | |
| 4 | 40분 | |
| 5 | 1h 20m | |
| 6 | 2h 40m | |
| 7 | 5h 20m | |
| 8 | 10h 40m | |
| 9 | 21h 20m | |
| 10 | — | 포기 (retry_after=NULL) |

상수:
- `BASE_DELAY_MS = 5 * 60 * 1000`
- `ATTEMPT_CAP = 10`

추출 성공 시: `done`/`empty`로 기록할 때 `attempt_count = 0`으로 리셋한다.

### 3. 영향받는 코드

#### upsertExtractionState (db.ts)
`ExtractionStateInsert`에 `attemptCount: number` 필드 추가.
INSERT/UPDATE 쿼리에 `attempt_count` 반영. ON CONFLICT UPDATE에도 포함.

#### hasPendingRetryExtractionState (indexer.ts) — 핵심 수정
현재 조건: `status='errored' AND retry_after IS NOT NULL AND retry_after > now`이면 건너뜀.

문제: 포기 건(`retry_after=NULL`)은 이 조건에 안 걸려 "대기 중 아님"으로 판단되고,
다시 추출이 시도된다 — 포기한 span을 또 호출하게 됨.

해결: 포기 건도 건너뛰도록 조건 추가. 가장 단순한 표현:

```sql
status='errored' AND attempt_count >= ?   -- ? = ATTEMPT_CAP(10); 포기 건은 무조건 건너뜀
```

를 기존 "아직 대기 중" 조건과 OR로 결합한다. 하드코딩 대신 `ATTEMPT_CAP` 상수를 바인딩한다.

#### verify.ts — 수정 없음 (확인만)
`status='errored' AND retry_after <= now`로 재시도 대상을 센다.
포기 건은 `retry_after=NULL`이라 `NULL <= now`가 거짓 → 자동으로 제외된다.

### 4. 테스트 (bun test)

TDD로 다음 시나리오 검증:

1. 실패 1회 → `attempt_count=1`, `retry_after ≈ now + 5분`.
2. 실패 누적 → 간격이 2배씩 증가 (5 → 10 → 20분).
3. `attempt_count`가 10에 도달 → `retry_after=NULL`(포기).
4. 포기 후 다음 sync → `hasPendingRetryExtractionState`가 true(건너뜀) 반환.
5. 성공 → `attempt_count=0` 리셋.

## 파일별 변경 요약

| 파일 | 변경 |
| --- | --- |
| `src/core/db.ts` | `attempt_count` 컬럼 + idempotent ALTER 마이그레이션; `ExtractionStateInsert`/`upsertExtractionState`에 attemptCount |
| `src/core/indexer.ts` | 실패 시 +1 / 지수 백오프 / 10회 포기; 성공 시 0 리셋; `hasPendingRetryExtractionState`에 포기 건 건너뛰기 |
| `src/core/verify.ts` | 수정 없음 (동작 확인) |
| 테스트 | 위 5개 시나리오 |
