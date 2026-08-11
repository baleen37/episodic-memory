# memmem → mem0 v2 아키텍처 복제

- 날짜: 2026-08-11
- 상태: 설계 승인 대기
- 성격: Breaking change. 기존 스키마/데이터/MCP 표면과 호환되지 않는다.

## 배경

현재 memmem 검색은 측정 가능한 방식으로 고장나 있다. 실제 DB(93,956건)에서 측정한 결과:

| 쿼리 | 1등 거리 | 2000등 거리 | 스코어 폭 |
| --- | --- | --- | --- |
| "memmem 검색 개선" | 0.505 | 0.587 | 0.664 → 0.630 |
| "Korean embedding model" | 0.434 | 0.600 | 0.698 → 0.625 |
| "점심 메뉴 추천" (DB에 답 없음) | 0.607 | 0.703 | 0.622 → 0.587 |

두 가지 결함이 확인됐다.

1. **스코어에 판별력이 없다.** 후보 2000개가 거리 0.08 구간에 몰려 있다. DB에 답이 없는 쿼리("점심 메뉴 추천")의 1등 점수 0.622가, 답이 있는 쿼리의 하위권보다 높다. 따라서 "맞음"과 "틀림"을 가르는 임계값이 존재할 수 없다. `1/(1+distance)` 공식이 좁은 거리 차를 추가로 뭉갠다.
2. **LIKE fallback이 상위권을 오염시킨다.** `search()`가 벡터 결과와 LIKE 결과를 Map으로 단순 합집합한다. LIKE 매치는 score가 없고 `observed_at DESC` 정렬이라, 무관한 최신 레코드가 상위에 섞인다.

다만 **순위 신호 자체는 살아 있다.** 정답이 1~3등에 올라온다. 망가진 것은 점수 표현과 결합 방식이다.

부수적으로 확인된 데이터 품질 문제:

- 동일 text 중복 4,234건 (고유 중복 text 1,353종)
- "The user's timezone is Asia/Seoul" 61회, "always communicate in Korean" 34회 — CLAUDE.md가 매 세션 프롬프트에 실려 span마다 재추출된다
- `The user %`로 시작하는 저가치 레코드 6,118건 (6.5%)
- 저장 언어: 영어 92,301 / 한국어 1,655 (98.2% 영어)
- `status`에 supersede 개념이 있으나 실사용 1건 — 사실상 append-only

## 결정

mem0 v2.0.17의 아키텍처를 스키마 수준까지 복제한다. 기존 코드 호환은 요구하지 않는다.

중요: mem0 v1의 두 단계 ADD/UPDATE/DELETE 파이프라인과 그래프 메모리는 **현재 코드에 존재하지 않는다**. `get_update_memory_messages`는 v2.0.17에서 grep 결과가 없고, `graph_memory.py`는 404다. 복제 대상은 v2의 ADD 전용 배치 파이프라인이다.

### 확정 사항

| 항목 | 결정 |
| --- | --- |
| 범위 | mem0 v2 스키마까지 완전 복제 |
| 기존 호환 | 불필요 (breaking change) |
| provenance / `fetch` | 포기 |
| BM25 | SQLite FTS5 (`unicode61`) |
| 엔티티 추출 | 추출 LLM 호출에 병합 |
| 재인덱싱 | 최근 것부터 점진적 |
| 저장 언어 | 영어 통일 |

## 제거되는 것

- **`fetch` MCP 도구** — MCP 표면은 `search` 하나만 남는다
- **`read` CLI 명령** — 되짚어갈 좌표가 없어 의미를 잃는다
- **`memory_records` 테이블** — `archive_path` / `line_start` / `line_end` / `source_kind` / `project` / `kind` / `status` / `supersedes_id` / `confidence` / `extraction_version` 전부 삭제
- **`extraction_state` 테이블** — span 단위 재시도/백오프는 배치 파이프라인에 불필요
- **fact/event 구분** — mem0는 플랫한 fact 하나만 갖는다
- **죽은 Observation API** — `db.ts` 396-486줄, 전부 `throw`하는 좀비 코드
- **기존 93,956건** — 스키마 비호환으로 폐기

`conversation-archive/`는 유지한다. 재인덱싱 소스로 필요하고 파일 복사라 비용이 없다.

## 새 스키마

### memories

mem0 `MemoryItem` (`mem0/configs/base.py`)을 따른다.

```sql
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,   -- UUID
  memory      TEXT NOT NULL,      -- fact 본문 (영어)
  hash        TEXT NOT NULL,      -- md5(memory), dedup 키
  metadata    TEXT,               -- JSON
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_memories_hash ON memories(hash);
```

`score`는 검색 시 계산되는 런타임 값이므로 컬럼이 아니다.

스코핑 키는 mem0와 동일하게 payload/metadata에 둔다: `user_id`, `agent_id`, `run_id`, `actor_id`, `role`, `attributed_to`, `expiration_date`. memmem 입력에 대한 매핑(세션 id → `run_id`, 소스 종류 → `agent_id` 등)은 구현 시 확정한다.

### history

append-only. mem0 `SQLiteManager`와 동일.

```sql
CREATE TABLE history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  TEXT NOT NULL,
  old_memory TEXT,
  new_memory TEXT,
  event      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0
);
```

### entities

`{data, entity_type, linked_memory_ids}` 별도 벡터 컬렉션.

### 검색 보조

- `vec_memories` — sqlite-vec 가상 테이블 (384-dim 유지)
- `fts_memories` — FTS5 (`tokenize='unicode61'`), BM25용

## 수집 파이프라인

mem0 v2 `_add_to_vector_store`의 8단계(`=== V3 PHASED BATCH PIPELINE ===`)를 그대로 따른다.

```
0. 세션 최근 10개 메시지 컨텍스트 확보
1. 배치 전체에 대해 벡터 검색 1회 (top_k=10), UUID → 정수 리맵
2. LLM 1회 — ADDITIVE_EXTRACTION_PROMPT, response_format=json_object
3. 배치 임베딩
4. md5 해시 dedup (기존 + 배치 내)
5. 배치 삽입
6. 배치 히스토리 기록
7. 엔티티 추출 및 링킹 (코사인 0.95 dedup)
```

핵심 성질:

- **LLM 갱신 판정 없음.** UPDATE/DELETE를 하지 않는다. 프롬프트가 명시한다: "Your sole operation is ADD". 모순되는 사실은 형제 행으로 누적되고 읽는 시점에 해소된다.
- **통합은 해시 비교로 처리.** LLM 중재 대신 md5 동일성으로만 충돌을 억제한다.
- **LLM 호출이 span당 1회 → 배치당 1회로 감소.** 재추출 비용이 크게 떨어진다.
- UUID를 정수 문자열로 리맵했다가 되돌리는 것은 mem0의 환각 방지 장치다. 그대로 채용한다.
- 추출 실패는 `LLMError`로 raise한다. 빈 배열을 조용히 반환하지 않는다 — "LLM 장애"와 "추출할 사실 없음"을 호출자가 구분할 수 있어야 한다.

## 검색

```
internal_limit = max(limit * 4, 60)
combined = min((semantic + bm25 + entity_boost) / max_possible, 1.0)
```

- `ENTITY_BOOST_WEIGHT = 0.5`
- `max_possible`: 1.0 (시맨틱만) / 2.0 (+BM25) / 1.5 (+엔티티) / 2.5 (전부)
- `threshold = 0.1`, **combined가 아니라 raw semantic score에 먼저 적용**
- 재랭킹은 opt-in, 기본 꺼짐 (`rerank=False`)
- `explain=True` → `score_details`에 `semantic_score`, `bm25_score`, `entity_boost`, `raw_score`, `max_possible_score`, `final_score`, `threshold` 노출
- 메타데이터 필터: `eq`, `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `contains`, `icontains`, 와일드카드 `*`, 불리언 `AND`/`OR`/`NOT`
- `filters`에 `user_id`/`agent_id`/`run_id` 중 최소 하나가 없으면 raise

threshold를 raw semantic에 먼저 적용하는 것은 BM25/엔티티 부스트가 구제할 후보를 미리 탈락시키는 부작용이 있다. mem0의 실제 동작이므로 그대로 따른다.

이 설계가 배경의 결함 1, 2에 직접 대응한다. 정규화된 점수가 0~1에 의미 있게 매핑되고, threshold가 무관한 결과를 자르며, LIKE 단순 합집합 대신 BM25가 가중합으로 참여한다.

## 스택 차이로 인한 대체

mem0는 Python/spaCy/Qdrant 기반이고 memmem은 Bun/TS다. 1:1이 불가능한 지점은 동작을 최대한 보존하되 스택에 맞게 대체한다.

| mem0 | memmem 대체 | 근거 |
| --- | --- | --- |
| BM25 (`text_lemmatized`) | SQLite FTS5 `unicode61` | 추가 의존성 없음. 영어 대상이라 정상 동작 |
| spaCy `extract_entities_batch` | 추출 LLM 호출에 엔티티 요청 병합 | TS에 spaCy 대응물 없음. 이미 호출하는 LLM이라 추가 비용 없음 |
| Qdrant | sqlite-vec | 기존 스택 유지 |

### FTS5 토크나이저 측정 결과

한국어 BM25 가능성을 실측했다 (SQLite 3.53.1):

| 쿼리 | `unicode61` | `trigram` |
| --- | --- | --- |
| "검색" (2글자) | 1건 | **0건** |
| "개선" (조사 뒤 부분어) | 0건 | 0건 |
| "개선하기" (3글자+) | — | 1건 |
| "embedding" (영어) | 1건 | 1건 |

`trigram`은 3글자 단위라 2글자 한국어 토큰을 색인하지 못한다. `unicode61`은 공백 분리라 조사가 붙은 형태("검색이", "개선하기")를 매칭하지 못한다. **FTS5로는 한국어 BM25가 성립하지 않는다.**

저장 언어를 영어로 통일하는 결정이 이 문제를 해소한다. `unicode61`은 영어에서 정상 동작한다.

## 저장 언어

추출 프롬프트가 항상 영어 fact를 생성한다. mem0 `ADDITIVE_EXTRACTION_PROMPT`를 그대로 쓰면 자연히 따라오며, 현재 데이터도 이미 98.2%가 영어다.

한국어 쿼리는 시맨틱 경로로 처리된다. multilingual-e5-small이 크로스링구얼이므로 한국어 쿼리 → 영어 기억 매칭이 동작한다 (실측: "memmem 검색 개선" 쿼리로 영어 기억이 상위에 반환됨).

## 재인덱싱

스키마를 새로 만들고 빈 상태로 시작한다. 이후 `sync`가 돌 때마다 채워진다. 과거분은 필요할 때 최근 것부터 수동으로 백필한다.

전량(5,045개 파일) 일괄 재인덱싱은 하지 않는다.

## 열린 이슈

1. **한국어 쿼리는 BM25 부스트를 받지 못한다.** 시맨틱 점수만으로 겨루는데, 배경에서 측정했듯 시맨틱 점수는 압축되어 있다. mem0의 정규화와 threshold가 개선하겠지만, 한국어 쿼리는 영어 쿼리 대비 구조적으로 불리하다. 대화가 한국어로 이루어지므로 실사용에서 체감될 수 있다. 구현 후 실측하여 판단한다.
2. **v2의 품질은 미검증이다.** 논문의 LOCOMO 수치(J=66.88%)는 v1 측정치다. v2는 LLM 중재 DELETE/UPDATE를 제거했으므로 그 수치가 이어진다고 가정할 수 없다. 공개된 v2 벤치마크는 없다.
3. **모순 누적.** ADD 전용이라 낡은 사실이 자동으로 제거되지 않는다. 시간이 지나면 형제 행으로 쌓인다. mem0의 알려진 트레이드오프이며, 읽는 시점에 해소하는 것이 전제다.

## 참고

- https://raw.githubusercontent.com/mem0ai/mem0/v2.0.17/mem0/memory/main.py — V3 배치 파이프라인
- https://raw.githubusercontent.com/mem0ai/mem0/main/mem0/configs/prompts.py — ADDITIVE_EXTRACTION_PROMPT
- https://raw.githubusercontent.com/mem0ai/mem0/main/mem0/utils/scoring.py — 하이브리드 스코어링
- https://raw.githubusercontent.com/mem0ai/mem0/v2.0.17/mem0/configs/base.py — MemoryItem 스키마
- https://docs.mem0.ai/core-concepts/memory-operations — ADD 전용 확인
- https://arxiv.org/pdf/2504.19413 — mem0 논문 (v1 측정)
