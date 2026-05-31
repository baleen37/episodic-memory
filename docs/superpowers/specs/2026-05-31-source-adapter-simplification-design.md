# Source Adapter 단순화 설계

날짜: 2026-05-31
범위: `src/core/sources/` (claude.ts, codex.ts, types.ts, index.ts)

## 배경

memmem은 `obra/episodic-memory`의 재구현이다. 레퍼런스는 `parser.ts` 한 파일에서
첫 줄을 보고 claude/codex를 자동 감지한 뒤 분기하는 단순한 구조다. memmem은
`SourceAdapter` 인터페이스(`roots`/`detect`/`parse`)를 도입해 어댑터별로 파일을
나눴는데, 이 과정에서 **공통 파싱 유틸이 claude.ts와 codex.ts에 그대로 복붙**됐다.

## 문제

claude.ts와 codex.ts에 다음이 2벌씩 중복되어 있다:

- `asObject`, `asString`, `parseTimestamp`, `stringifyValue` — 완전히 동일
- `parseJsonObject` (라인 → JSON) — 동일
- `extractText` — 거의 동일 (claude는 `content` 필드도 봄)
- JSONL 라인 순회 (`content.split(/\r?\n/)` + 빈 줄/파싱 실패 skip) — 동일 골격
- tool_result 매칭 ("callId로 output 없는 call 찾아 채우고, 없으면 stub push") — 미묘하게 다른 2벌

## 목표

공통 유틸과 tool_result 매칭을 `sources/jsonl.ts` 한 곳으로 모은다.
어댑터 인터페이스와 모든 동작·메타데이터는 그대로 유지한다.
**순수 리팩터링** — 동작 변화 없음, 기존 테스트 그대로 통과.

## 변경 사항

### 신설: `src/core/sources/jsonl.ts`

- 공통 JSON 유틸: `asObject`, `asString`, `parseTimestamp`, `stringifyValue`
- 라인 순회: `eachJsonLine(content, fn)` — JSONL을 `(object, lineNumber)`로 순회.
  빈 줄과 파싱 실패는 skip (claude/codex 동일 동작).
- tool_result 매칭: `attachToolResult(calls, { callId, output, status })` —
  output 없는 동일 callId call을 찾아 채우고, 없으면 output-only stub을 push.

### `src/core/sources/claude.ts`

- 로컬 유틸 6개 제거 → `jsonl.ts`에서 import
- `applyToolResult`/`applyToolResults`를 공통 `attachToolResult` 호출로 교체
- `extractText`는 claude 고유(`content` 필드 처리) 차이가 있으므로 claude.ts에 유지
- `parseClaudeJsonl` 본체와 claude 고유 로직(content 블록의 `tool_use`/`tool_result`
  해석, `message.role` 처리)은 그대로

### `src/core/sources/codex.ts`

- 로컬 유틸 import로 교체
- tool_result 매칭을 공통 `attachToolResult` 호출로 교체
- `extractText`(codex는 `text` 필드만)와 codex 고유 로직(`session_meta`/
  `turn_context`/`response_item`, `isToolCallType`/`isToolOutputType`)은 그대로

### 변경 없음

- `types.ts`, `index.ts`
- 어댑터 인터페이스(`roots`/`detect`/`parse`)
- 모든 메타데이터 필드, exclusion marker, .no-memmem 제외, atomic copy

## 공통화하지 않는 부분

claude와 codex는 포맷 자체가 다르다:

- claude: 메시지 타입이 `item.type`/`message.role`, tool은 content 배열 안 블록
- codex: 메시지 타입이 `payload.type`, tool은 별도 `response_item`, `session_meta`로
  메타 누적

이 차이는 어댑터별로 남기는 게 맞다. 공통화 대상은 유틸과 매칭 메커니즘뿐이다.

## 검증

- `bun test src/core/sources/` → 기존 7개 테스트 그대로 통과 (성공 기준)
- `bun run typecheck` 통과
- diff가 "삭제 위주 + import 추가" 형태인지 확인 (동작 코드는 이동만)
