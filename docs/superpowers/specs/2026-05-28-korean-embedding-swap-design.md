# 한국어 임베딩 모델 교체 설계

## 목적

검색 품질의 한국어 약점을 해소한다. 현재 `Supabase/gte-small`은 영어 위주 학습이라 한국어/영어/코드가 섞인 memmem transcript에서 한국어 질의 retrieval이 명백히 떨어진다.

## 결정 사항

- **새 모델**: `dragonkue/multilingual-e5-small-ko-v2`
- **이유**: 33M 파라미터, 384-dim — 현재 `gte-small`과 동일한 크기/차원. DB 스키마/RAM/지연 영향이 사실상 없다. e5 계열로 다국어 베이스에 한국어 fine-tune이 더해져 한국어 retrieval은 개선되고 영어/코드는 e5의 다국어 능력으로 유지된다. dragonkue가 만든 `snowflake-arctic-embed-l-v2.0-ko`의 경량 동생 격이며 Xenova ONNX 빌드가 존재해 Transformers.js와 호환된다.
- **거절한 후보**:
  - `nlpai-lab/KURE-v1` (~568M): SessionStart 훅에서 매번 도는 sync에 부담. ONNX 직접 변환 필요.
  - `dragonkue/snowflake-arctic-embed-l-v2.0-ko` (~300M): Ko-MTEB retrieval은 최상이지만 Transformers.js에서 ONNX 변환 이슈 보고됨. 차원 1024로 DB 변경 필요.
  - `Xenova/bge-m3` (~568M): 한국어 강하지만 무겁고 차원 변경 필요.
  - `intfloat/multilingual-e5-small` (33M): 베이스 모델. 한국어 fine-tune이 없는 만큼 dragonkue 변형보다 한국어 성능 보장이 약함.

## 범위

**포함**:
- 임베딩 모델 ID 교체
- e5 `passage:` / `query:` prefix 규칙을 반영하는 API 변경
- `embedding_version` bump → 다음 sync에서 모든 archive 자동 재인덱싱
- 테스트 mock 시그니처 갱신
- `CLAUDE.md`의 모델 언급 갱신

**제외 (YAGNI)**:
- 차원 변경, DB 마이그레이션 스크립트
- 청킹 전략, hybrid scoring 가중치, ColBERT 도입
- 기존 모델과의 동시 지원 / 점진 마이그레이션
- 모델 선택을 사용자가 config로 바꿀 수 있게 만드는 기능

## 아키텍처

### API 변경: 단일 함수 → 두 함수

e5 모델은 인덱싱과 검색에서 prefix가 다르다. 호출부에서 의도를 드러내고 model 레이어가 prefix를 관리한다.

```ts
// src/core/embeddings.ts
export async function embedPassage(text: string): Promise<number[] | null>;
export async function embedQuery(text: string): Promise<number[] | null>;
```

내부 헬퍼 `run(kind, text)`가 rate limiter, disabled 체크, error handling을 공유한다. 두 함수는 `kind`만 다른 wrapper다.

### prefix 캡슐화

e5 prefix 지식은 `embeddings-model.ts`에만 존재한다. 다음에 모델을 또 바꿀 때 `embeddings.ts`와 호출부는 건드리지 않아도 된다.

```ts
// src/core/embeddings-model.ts
const PREFIX = { passage: 'passage: ', query: 'query: ' } as const;
const MAX_CONTENT_CHARS = 8000;

export async function generateEmbeddingFromModel(
  kind: 'passage' | 'query',
  text: string,
): Promise<number[] | null> {
  const truncated = text.slice(0, MAX_CONTENT_CHARS);
  const input = PREFIX[kind] + truncated;
  const out = await pipeline(input, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}
```

`normalize: true`는 그대로 유지 — e5의 cosine similarity 사용 전제와 일치.

### truncation

prefix는 8자 남짓이라 8000자 예산에서 빼지 않고 prefix를 항상 보존한다. 사용자 텍스트만 8000자로 자른다. 단순성을 위해 글자 단위 truncation 유지(현재 동작과 동일).

### 자동 재인덱싱

현재 `sync`는 archive에 있는 모든 파일을 매번 `reindexArchiveFile`로 통과시킨다. 이 동작 자체는 모델 교체와 무관하게 모든 exchange를 다시 임베딩하므로 별도의 마이그레이션 로직은 필요하지 않다.

- `CURRENT_EMBEDDING_VERSION = 1` → `2`로 bump (메타데이터 정확성)
- 모델 교체된 빌드를 사용자가 받으면, 다음 SessionStart 훅의 sync에서 모든 archive가 새 모델로 재인덱싱된다
- 재처리 경로(`deleteExchangeIndexForArchivePath` → `insertExchange`)는 변경 없음

`CURRENT_EMBEDDING_VERSION`은 인덱싱된 exchange의 메타데이터로 남아 있어 디버깅과 향후 stale 감지 기능에 사용될 수 있다. `getArchivePathsNeedingReindex`는 현재 sync 경로에서 호출되지 않으므로 동작에 직접 영향을 주지 않는다 (테스트에서만 사용 중).

### 사용자 안내

이 작업은 `sync` CLI에 안내 메시지를 추가하지 않는다. 매 sync마다 동일한 양의 작업이 일어나므로 "모델이 업데이트되어 재인덱싱"이라는 일회성 메시지는 의미가 없다.

대신 모델이 처음 로드될 때 출력되는 기존 메시지(`embeddings-model.ts`의 `'Loading embedding model (first run may take time)...'`)가 첫 실행 안내 역할을 한다. 모델 이름은 메시지에 노출되지 않으므로 사용자 입장에서 이전과 동일한 경험이다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `src/core/embeddings-model.ts` | 모델 ID 교체, `generateEmbeddingFromModel(kind, text)` 시그니처, `PREFIX` 테이블 |
| `src/core/embeddings.ts` | `embedPassage` / `embedQuery` 두 함수, 내부 `run` 헬퍼, `__setModelForTests` 시그니처 갱신 |
| `src/core/db.ts` | `CURRENT_EMBEDDING_VERSION = 2` |
| `src/core/indexer.ts` | 호출부 → `embedPassage` |
| `src/core/search.ts` | 호출부 → `embedQuery` |
| `src/core/embeddings.test.ts` | mock 시그니처 갱신, prefix 의도가 호출부에서 올바르게 전달되는지 검증하는 단위 테스트 추가 |
| `src/core/indexer.test.ts`, `src/core/search.test.ts`, `src/cli/sync.test.ts` | `__setModelForTests` mock 시그니처를 `(kind, text) => vector`로 갱신 |
| `CLAUDE.md` | `embeddings.ts` 설명 줄을 새 모델 기준으로 갱신 |

## 테스트 전략

**단위 (자동)**:
- `embedPassage(text)` 호출 시 model 레이어가 `kind='passage'`, `query:`가 아닌 `passage:` prefix가 적용된 입력을 받는지 검증
- `embedQuery(text)` 대칭 검증
- truncation은 사용자 텍스트에만 적용되고 prefix는 항상 보존되는지 검증
- 기존 indexer/search 테스트는 mock 시그니처만 갱신 (행위 변화 없음)

**통합 (수동, 한 번)**:
- `bun run build && bun run typecheck && bun test` 통과
- `bun dist/cli.mjs sync` 한 번 실행: 모델 로드 성공, 안내 메시지 표시, 모든 archive 재인덱싱 완료
- 한국어 질의 두세 개로 검색 결과의 정성적 개선 확인 (예: "메모리 누수 디버깅" 같은 한글 검색이 관련 transcript를 찾는지)
- DB의 `embedding_version` 값이 모두 2인지 SQL로 점검

## 리스크 및 완화

| 리스크 | 영향 | 완화 |
|---|---|---|
| `dragonkue/multilingual-e5-small-ko-v2`의 ONNX 빌드가 Transformers.js에서 실패 | 모델 로드 안 됨, 사용자가 검색 못함 | 첫 실행에서 명확한 에러 노출. 폴백 없음. 실패 시 `Xenova/multilingual-e5-small`(베이스 e5-small)로 임시 전환 가능 — 한국어 향상폭은 작아지지만 ONNX 호환 보장. |
| 첫 sync가 사용자 transcript 양만큼 오래 걸림 | 첫 실행시 SessionStart 훅이 평소보다 느림 | 현재도 매 sync마다 모든 archive를 통과시키므로 행위 변화는 없음. 모델 로드 시 출력되는 기존 메시지가 사용자 안내 역할. |
| prefix를 빠뜨린 옛 호출부가 남음 | 검색 품질 저하 | `generateEmbedding`을 완전히 제거해서 컴파일 에러로 강제 검출. grep으로 잔존 호출 확인. |
| 테스트 mock이 prefix 검증을 안 함 | 회귀가 테스트로 안 잡힘 | `embeddings.test.ts`에 prefix 정확성 단위 테스트 신규 추가. |

## 성공 기준

1. `bun test` 전부 통과
2. `bun run typecheck` 통과
3. `bun run build` 통과
4. 실제 sync 실행 시 모델 로드 성공, 모든 archive가 `embedding_version=2`로 재인덱싱됨
5. 한국어 질의 샘플에서 정성적으로 결과 적합도 개선이 관찰됨
6. 영어 질의 샘플에서 회귀 없음
