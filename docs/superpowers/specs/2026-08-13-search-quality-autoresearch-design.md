# Search Quality Autoresearch Design

Date: 2026-08-13

## Objective

memmem의 검색 품질을 실제 변경 전후로 측정할 수 있게 만들고, 고정된 평가셋에서 점수가 유의미하게 오른 검색 알고리즘만 유지한다.

Primary metric은 `nDCG@10`으로 둔다. 검색 속도는 이번 작업의 최적화 목표가 아니지만, p95 latency와 메모리 scope 정확성을 correctness gate로 계속 감시한다.

## Current Context

현재 검색 경로는 다음과 같다.

1. 질의를 multilingual-e5-small query embedding으로 변환한다.
2. sqlite-vec KNN에서 semantic 후보를 가져온다.
3. FTS5 BM25 결과를 semantic 후보와 연결한다.
4. semantic score와 BM25 score를 adaptive divisor로 합산한다.
5. threshold를 semantic score에 먼저 적용하고 top-K를 반환한다.

현재 로컬 인덱스에는 1,328개 메모리가 있고 모두 벡터화되어 있다. 검색 품질을 자동 비교하는 고정 benchmark와 relevance label은 아직 없다.

## Goals

- 검색 품질을 재현 가능한 숫자로 측정한다.
- 비식별 fixture로 BM25, semantic, hybrid ranking 변경을 비교한다.
- 실제 인덱스에서 발생할 수 있는 scope 누출, 중복, 빈 결과, latency 회귀를 별도 gate로 검증한다.
- autoresearch 방식의 noise floor, 단일 변경 실험, locked evaluator, worklog를 적용한다.
- 첫 검색 개선 가설로 semantic 후보 밖의 강한 lexical 후보가 탈락하는 문제를 검증한다.

## Non-goals

- 이번 단계에서 LLM 기반 query rewriting을 추가하지 않는다.
- embedding 모델을 교체하거나 재학습하지 않는다.
- 실제 대화 원문, metadata, production query log를 저장소에 커밋하지 않는다.
- 검색 API의 입력 형식이나 MCP scope 규칙을 변경하지 않는다.
- 검색 속도 자체를 primary objective로 삼지 않는다.

## Evaluation Dataset

### Sanitized corpus

고정 corpus는 `tests/fixtures/search-quality-corpus.json`에 저장한다. 내용은 실제 대화에서 복사하지 않은 비식별 문장으로 작성하고, 다음 검색 특성을 포함한다.

- 영어 메모리와 한국어 질의의 cross-lingual 매칭
- 정확한 프로젝트명, 도구명, 사람·동물 이름과 같은 rare token
- 긴 질의의 부분 일치
- semantic 유사하지만 답이 아닌 distractor
- 같은 주제의 최신·이전 사실
- metadata scope가 다른 동일 주제 문장
- BM25만 강한 문장과 semantic만 강한 문장

각 fixture row는 `id`, `memory`, `metadata`, `embedding`을 가진다. embedding은 benchmark 실행 시 사용하는 고정 mock model과 같은 좌표계에 둔다.

### Query judgments

`tests/fixtures/search-quality-queries.json`에 40개 이상의 질의를 저장한다. 각 질의는 다음 형태를 갖는다.

```json
{
  "query": "which project uses the local memory index?",
  "filters": { "user_id": "local" },
  "relevance": { "memory-001": 3, "memory-014": 1 }
}
```

relevance 등급은 고정한다.

- `3`: 질의에 대한 직접적인 답 또는 가장 적합한 최신 사실
- `2`: 질문의 일부를 직접 뒷받침하는 관련 사실
- `1`: 배경 맥락은 맞지만 답으로는 부족한 사실
- `0`: 무관하거나 잘못된 사실. 파일에는 필수로 기록하지 않고 미등장 결과에 적용한다.

평가셋에는 결과가 없는 질의와 특정 metadata scope 안에서만 정답이 존재하는 질의를 포함한다.

### Production smoke separation

실제 `~/.config/memmem` 인덱스는 품질 점수 산정에 사용하지 않는다. 대신 구현 후 로컬 smoke에서 고정된 일반 질의를 실행하고 다음만 확인한다.

- 반환된 모든 결과가 요청 scope와 일치한다.
- 결과 ID가 중복되지 않는다.
- 결과 수가 limit 이하이다.
- 결과 score가 `[0, 1]` 범위이다.
- 검색 실패가 process crash로 이어지지 않는다.

Smoke 출력에는 memory text나 metadata 전체를 저장하지 않는다.

## Metrics

### Primary

`nDCG@10`을 전체 질의의 macro average로 계산한다. graded relevance를 사용하므로 직접 답변, 부분 관련, 배경 맥락의 차이를 반영할 수 있다. 값이 높을수록 좋다.

### Secondary

- `recall_at_5`: relevance 2 이상인 정답 중 top 5에 포함된 비율
- `mrr_at_10`: 첫 relevance 2 이상 결과의 reciprocal rank
- `empty_rate`: relevance 2 이상 정답이 있는데 결과가 비어 있는 질의 비율
- `p95_ms`: benchmark 실행의 검색 p95 latency

`nDCG@10`만 keep/discard 판정에 사용한다. secondary metric은 분석과 correctness gate에 사용한다.

## Locked Benchmark

`scripts/search-quality-benchmark.ts`가 평가셋을 읽고 `METRIC name=value` 형식으로 metric을 출력한다. 다음 파일은 실험 중 수정 금지다.

- `scripts/search-quality-benchmark.ts`
- `tests/fixtures/search-quality-corpus.json`
- `tests/fixtures/search-quality-queries.json`
- metric 계산에 사용되는 fixture loader와 평가 함수

Benchmark는 고정 mock embedding, 고정 fixture, 고정 query 순서를 사용한다. baseline을 5회 실행해 metric noise를 확인하고, 품질 metric의 noise floor를 계산한다. deterministic fixture에서 noise가 0이면 `noiseFloor=0`으로 기록한다. latency noise는 별도 참고값으로 기록한다.

`scripts/search-quality-check.sh`는 benchmark와 별도로 다음 correctness invariant를 검사한다.

- `bun test`가 통과한다.
- typecheck가 통과한다.
- 결과 scope가 filter 밖으로 나가지 않는다.
- 결과가 중복되지 않는다.
- 결과 score가 유효한 범위에 있다.

Benchmark와 check script를 수정해야 한다면 일반 실험으로 처리하지 않고 evaluator 변경 및 re-baseline으로 별도 기록한다.

## First Experiment: Lexical Candidate Recall

현재 FTS5 query 결과는 semantic 후보 map에 존재할 때만 BM25 점수에 참여한다. 따라서 강한 lexical match가 semantic KNN 후보 범위 밖에 있으면 ranking에 들어오지 않는다.

첫 실험은 후보 생성만 바꾼다.

1. 기존 semantic 후보를 유지한다.
2. FTS5 후보를 별도로 가져온다.
3. 두 후보의 rowid union을 만든다.
4. metadata filter를 union 후보에 적용한다.
5. semantic 후보에 없던 lexical 후보는 semantic component를 `0`으로 두고, 양의 BM25 score가 있으면 threshold semantic gate에서 탈락시키지 않는다.
6. 기존 score normalization, top-K, API response shape는 유지한다.

이 실험의 가설은 “정확한 rare token 또는 부분 keyword가 semantic top-K 밖에 있어도 ranking 후보가 되면 nDCG@10이 오른다”이다. 점수가 오르지 않거나 empty rate·scope correctness가 악화되면 변경을 폐기한다.

## Follow-up Experiment Order

첫 실험 이후에는 한 번에 하나의 lever만 바꾼다.

1. lexical candidate depth와 semantic candidate depth
2. semantic/BM25 normalization 및 weight
3. 긴 질의에서의 term weighting
4. 최신 사실과 오래된 사실이 충돌할 때의 recency tie-break

query expansion, multi-query, LLM reranking은 앞선 변경으로 충분한 개선이 없을 때 별도 실험군으로 만든다. 각 실험은 latency와 embedding 호출 수를 함께 기록한다.

## Autoresearch Session Artifacts

실험 브랜치에는 다음 파일을 둔다.

- `autoresearch.md`: 목표, metric, noise floor, scope, off-limits, 제약
- `autoresearch.jsonl`: config header와 run별 metric·status·parent
- `experiments/worklog.md`: 각 실험의 변경, 결과, insight, 다음 가설
- `autoresearch-dashboard.md`: baseline, best, 전체 run과 delta

이 파일들은 실험 재개를 위해 필요하지만 production package에는 포함하지 않는다. `.gitignore` 정책에 맞춰 실험 상태를 관리하고, 최종적으로 유지된 소스 변경과 benchmark fixture만 별도 커밋한다.

## Success Criteria

- baseline benchmark가 고정된 metric을 출력한다.
- 현재 검색 구현의 baseline `nDCG@10`, `Recall@5`, `MRR@10`, `empty_rate`, `p95_ms`가 기록된다.
- 첫 lexical candidate 실험이 baseline보다 noise floor를 초과해 nDCG@10을 개선하거나, 개선되지 않아 근거와 함께 폐기된다.
- 모든 kept change에서 `bun test`, `bun run typecheck`, `bun run build`, correctness gate가 통과한다.
- 실제 로컬 인덱스 smoke에서 scope 누출과 결과 형식 회귀가 없다.

## Risks

- fixture가 실제 사용자 질의를 충분히 대표하지 못할 수 있다. 초기 benchmark는 알고리즘 회귀 방지용이며, 이후 사용자 승인 하에 비식별 query를 추가한다.
- lexical-only 후보의 semantic score를 0으로 두면 BM25 후보가 과대 또는 과소 평가될 수 있다. 이 동작은 첫 실험의 명시적인 가설이며, score formula까지 동시에 바꾸지 않는다.
- 실제 인덱스의 데이터 분포와 fixture의 분포가 다를 수 있다. production smoke는 품질 점수가 아닌 scope·형식·crash 검증으로 분리한다.
