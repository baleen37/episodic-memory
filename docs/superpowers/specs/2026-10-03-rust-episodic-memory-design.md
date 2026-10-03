# Rust episodic-memory 설계

## 1. 목표

- episodic-memory 내부를 TypeScript/bun + mem0 v2(LLM 추출)에서 **Rust 단일 바이너리**로 바꾼다.
- 플러그인 이름, 데이터 디렉터리, 아카이브는 그대로 쓴다. 새 버전은 4.0.0(breaking)이다.
- episodic 축만 다룬다. 지난 세션의 대화를 exchange 단위로 남기고 검색한다. LLM 추출·요약, semantic memory는 없다.
- **성공 기준**: 세션 1에서 한 작업을 세션 2(Claude Code 또는 Codex)에서 `search`로 찾고, `read`로 원문을 읽을 수 있다.
- **단계**: 1단계는 §3~§9(4.0.0 릴리스). 2단계는 §10(1단계 E2E 통과 후, 4.x 마이너 릴리스).

## 2. 참고와 결정

기본은 `obra/episodic-memory` v1.6.0(2026-09-08)을 따른다. 다르게 가는 곳만 적는다.

| 항목 | 결정 | 출처·이유 |
|---|---|---|
| 검색 단위 | exchange(사용자 메시지 1개 + 그 턴의 답변 + 도구 호출) | obra 그대로 |
| 원본 | 아카이브가 원본. `read`는 아카이브 원문을 보여준다. 아카이브는 덮어쓰지 않는다 | obra는 원본이 바뀌면 아카이브를 덮어쓴다. 호스트가 30일 뒤 transcript를 지우므로 아카이브가 유일한 사본이다 |
| 아카이브 복사 | 파일 전체가 아니라 offset 이후 추가분만 append | obra는 mtime이 바뀌면 파일 전체를 다시 복사한다(`sync.ts:146-162`) |
| 텍스트 검색 | FTS5 + 한글 bigram terms, BM25 | obra는 `LIKE` AND. `LIKE`는 행 수에 비례해 느리고 순위가 없다. 형태소 사전(lindera)은 쓰지 않는다(§6) |
| 결과 합치기 | 가중 RRF(K=60, BM25 0.4 / 벡터 0.6) + BM25 상위 3등 가산점 | agentmemory `hybrid-search.ts:20,30-31`. obra는 벡터 결과 뒤에 텍스트 결과를 붙인다 |
| 벡터 필터 | sqlite-vec 메타데이터 컬럼으로 KNN 안에서 건다 | obra는 KNN 뒤에 필터해 결과가 빌 수 있어 over-fetch로 우회한다 |
| 임베딩 모델 | multilingual-e5-small(384차원, fp32) | obra의 bge-small-en-v1.5는 영어 전용이다. 지금 레포가 쓰는 모델이다 |
| 런타임 | 상주 데몬 1개가 모델·검색·sync를 맡는다 | obra는 세션마다 MCP 서버가 모델을 따로 올린다 |
| 기록 트리거 | SessionStart 훅이 데몬에 sync를 요청한다. 주기적 스캔·Stop 훅은 없다 | obra와 같은 시점. 오래 열린 세션은 다음 SessionStart까지 색인되지 않는다 |
| MCP 도구 | `search`, `read` 2개. `search` 입력을 줄였다(§6) | obra에서 `mode`, `session_id`, `git_branch`, `include_sidechains`, `response_format` 제외 |
| project | git common-dir 상위 디렉터리 이름 | worktree가 같은 project로 묶인다(agentmemory#515) |
| 개인정보 | `DO NOT INDEX` 표시만, 사용자 메시지에서만 찾는다. 마스킹 없음 | obra는 도구 출력까지 파일 전체에서 찾는다. 이 문서를 읽기만 해도 세션이 빠지는 일을 막는다 |
| 지원 플랫폼 | macOS arm64, Linux x86_64·aarch64 | Intel Mac은 ort 정적 사전빌드가 없어 제외한다 |

## 3. 런타임

```
SessionStart 훅 ─ episodic-memory sync ──┐  sync 요청만 보내고 종료
세션 A ─ episodic-memory mcp ─┐           │
세션 B ─ episodic-memory mcp ─┴───────────┴─ daemon-{VER}.sock ─ episodic-memory daemon
                                                                 ├ MCP JSON-RPC (search, read)
                                                                 ├ e5-small 모델 (1회 로드)
                                                                 └ sync 작업 (요청이 올 때만)
```

- **서브커맨드 3개**: `sync`, `mcp`, `daemon`.
- **연결 첫 줄**: 클라이언트는 연결 직후 `{"client":"mcp"}` 또는 `{"client":"sync"}` 한 줄을 보낸다. `mcp`는 그 뒤로 stdio와 소켓을 바이트 그대로 잇는다.
- **sync (훅)**: 데몬에 연결해 요청 한 줄을 보내고 바로 exit 0. 데몬이 없으면 detached로 띄우기만 하고 끝낸다. 데몬은 기동할 때 sync를 한 번 돌기 때문이다.
- **sync 작업**: 데몬 안에서 한 번에 하나만 돈다. 도는 중에 요청이 오면 끝난 뒤 한 번 더 돈다. 요청이 여러 개 쌓여도 한 번으로 합친다. 모델 로드가 끝나면 데몬이 자기에게 sync 요청을 한 번 넣는다(밀린 임베딩 처리).
- **sync 락**: sync 작업은 버전과 무관한 `sync.lock`에 `flock`을 잡고 돈다. 업그레이드 중 구·신 데몬이 함께 떠 있어도 sync는 하나만 돈다. 락을 못 잡으면 그 회차를 건너뛴다.
- **DB 쓰기는 sync 작업만 한다.** 검색과 `read`는 읽기만 한다.
- **mcp**: 소켓 연결에 실패하면 데몬을 detached로 띄우고 백오프하며 재시도한다. 10초 안에 연결하지 못하면 종료하고, 호스트가 MCP 서버 에러를 보여준다.
- **싱글턴**: `daemon-{VER}.lock`에 `flock`. 락을 못 잡은 쪽은 바로 종료한다.
- **유휴 종료**: 클라이언트 0개, sync 작업 없음 상태로 10분이 지나면 종료한다.
- **버전 교체**: 소켓·데몬 락이 버전별이다. 구버전 데몬은 클라이언트가 사라지면 스스로 종료한다.
- **모델**: fastembed 7.1 `EmbeddingModel::MultilingualE5Small`. 첫 기동 때 `with_cache_dir(<data>/models)`로 받는다. fastembed는 `HF_HOME`을 캐시 경로보다 우선하므로 데몬은 시작할 때 자기 환경에서 `HF_HOME`을 지운다. 받는 동안과 로드에 실패했을 때 `search`는 BM25만 쓴다.

## 4. 저장

위치: `~/.config/episodic-memory/` (`EPISODIC_MEMORY_DIR`로 바꿀 수 있다, 테스트용)

- 아카이브: `conversation-archive/<source_kind>/<원본 루트 기준 상대경로>`. 지금 레이아웃 그대로.
- DB: `episodic.db`(새 파일). 기존 `conversations.db`는 읽지도 지우지도 않는다.

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;

files(source_path TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,           -- claude-code-projects | claude-code-transcripts | codex-sessions
      archive_path TEXT NOT NULL UNIQUE,   -- 현재 세대 아카이브 파일
      generation INTEGER NOT NULL DEFAULT 0,
      offset INTEGER NOT NULL DEFAULT 0,   -- 불변식: 아카이브 파일 크기 == offset
      reparse_line INTEGER NOT NULL DEFAULT 1,  -- 다음 파싱을 시작할 아카이브 줄(1부터)
      session_id TEXT, cwd TEXT, project TEXT,  -- 첫 파싱 때 파일 머리에서 읽어 저장
      harness TEXT, is_sidechain INTEGER,
      skipped INTEGER NOT NULL DEFAULT 0)  -- DO NOT INDEX

exchanges(id INTEGER PRIMARY KEY AUTOINCREMENT,   -- 지운 id를 재사용하지 않는다
          archive_path TEXT NOT NULL,
          line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
          session_id TEXT,
          project TEXT NOT NULL,
          harness TEXT NOT NULL,            -- claude | codex
          is_sidechain INTEGER NOT NULL DEFAULT 0,
          ts INTEGER NOT NULL,              -- unix ms, 사용자 메시지 시각
          user_message TEXT NOT NULL,
          assistant_message TEXT NOT NULL,  -- 그 턴의 답변 텍스트를 빈 줄로 이은 것
          tool_names TEXT NOT NULL DEFAULT '',  -- 쉼표로 이은 도구 이름
          embedded INTEGER NOT NULL DEFAULT 0)
CREATE INDEX exchanges_file ON exchanges(archive_path, line_start);
CREATE INDEX exchanges_pending ON exchanges(id) WHERE embedded = 0;

CREATE VIRTUAL TABLE fts_exchanges USING fts5(terms, content='', contentless_delete=1,
       tokenize='porter unicode61 remove_diacritics 2');   -- rowid = exchanges.id

CREATE VIRTUAL TABLE vec_exchanges USING vec0(
  embedding float[384],
  project TEXT, ts INTEGER, is_sidechain INTEGER);         -- rowid = exchanges.id

meta(key TEXT PRIMARY KEY, value TEXT)   -- 마지막 sync 시각·에러 등
```

- **exchange 삭제**는 한 함수로만 한다. 같은 트랜잭션에서 `fts_exchanges`, `vec_exchanges`의 같은 rowid를 먼저 지운 뒤 `exchanges`를 지운다. 두 가상 테이블은 FK를 지원하지 않기 때문이다.
- `contentless_delete=1`은 SQLite 3.43+가 필요하다. rusqlite `bundled`를 쓴다.
- sqlite-vec는 0.1.9 이상(그 미만은 TEXT 메타데이터 행 DELETE 버그). `sqlite3_auto_extension`으로 등록한다.
- 도구 입력·결과는 DB에 저장하지 않는다. 도구 이름만 `tool_names`에 두고, 원문은 `read`가 아카이브에서 렌더링한다.
- `fts_vocab`: `CREATE VIRTUAL TABLE fts_vocab USING fts5vocab(fts_exchanges, row)`. 검색어 토큰의 문서 빈도를 볼 때 쓴다(§6).
- 스키마 버전은 `PRAGMA user_version`. 마이그레이션은 추가만 한다.

## 5. sync

**발견**: 아래 루트 아래의 `*.jsonl`을 재귀로 찾아 크기만 `stat`한다. 깨진 심볼릭 링크와 읽을 수 없는 파일은 건너뛴다.

| source_kind | 루트 |
|---|---|
| claude-code-projects | `$CLAUDE_CONFIG_DIR/projects` 또는 `~/.claude/projects` (서브에이전트 `<session>/subagents/agent-*.jsonl` 포함) |
| claude-code-transcripts | `~/.claude/transcripts` (있을 때만) |
| codex-sessions | `$CODEX_HOME/sessions` 또는 `~/.codex/sessions` |

**파일 하나 처리** — 원본 크기가 `offset`과 다를 때만 처리한다. 같으면 건너뛴다. 따라서 크기가 같은 채로 내용만 다시 써진 파일은 감지하지 않는다(호스트 transcript는 append 전용이라 실제로 생기지 않는다).

1. **새 원본**(`files`에 없음): 아카이브 경로에 파일이 이미 있으면 아래 "기존 아카이브 들여오기" 규칙으로 등록한다. 없으면 `offset=0`으로 등록한다.
2. **불변식 맞추기**: 아카이브 크기가 `offset`보다 크면(지난번 append 뒤 커밋 전에 죽은 경우) `offset`으로 잘라낸다. 아카이브가 `offset`보다 작거나 없으면(외부에서 지워짐) 3번의 새 세대로 간다.
3. **다시 써졌는지 확인**: `offset > 0`이면 원본의 `[offset-4KB, offset)` 구간이 아카이브의 같은 구간과 같은지 비교한다. 원본 크기가 `offset`보다 작거나 구간이 다르면 다시 써진 것이다.
   - **새 세대**: 기존 아카이브 파일은 이름도 내용도 건드리지 않는다. 한 트랜잭션에서 그 파일의 exchange를 지우고, `generation`을 1 올리고, `archive_path`를 `<name>.gen-<generation>.jsonl`로, `offset=0`, `reparse_line=1`로 바꿔 **커밋한 뒤** 4번으로 간다. 새 경로에 남은 부분 파일이 있으면 2번 불변식이 0으로 잘라낸다.
   - 이전 세대의 exchange를 지우는 이유: 다시 써진 파일은 대개 이전 내용을 포함하므로 두 세대를 모두 색인하면 결과가 중복된다. 이전 세대 파일은 디스크에 남아 복구할 수 있다.
4. **append**: `offset`부터 원본의 마지막 개행까지를 아카이브에 append하고 fsync한다. 미완결 마지막 줄은 다음 sync로 넘긴다.
5. **트랜잭션 시작**. `offset`을 새 크기로 올린다.
6. `skipped=1`이면 커밋하고 끝낸다.
7. **파싱**: 아카이브를 `reparse_line`부터 끝까지 파싱한다. `files`의 세션 정보가 비어 있으면 파일 머리부터 읽어 채운다. 그 파일에서 `line_start >= reparse_line`인 exchange를 지운 뒤, 파싱한 exchange를 넣는다(FTS terms 포함). 마지막 exchange의 `line_start`를 새 `reparse_line`으로 둔다. 마지막 exchange는 진행 중일 수 있어 다음에 파일이 커지면 다시 만든다.
8. 사용자 메시지에 `<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>`가 있으면 `skipped=1`로 바꾸고 그 파일의 exchange를 모두 지운다. 도구 출력이나 답변에 나온 표시는 무시한다.
9. `user_message`나 `assistant_message`가 256KB를 넘는 exchange는 넣지 않고 개수만 로그에 남긴다(obra#139).
10. **커밋**.

**임베딩**: 모든 파일을 처리한 뒤, 같은 sync 작업 안에서 `embedded=0`인 exchange를 8개씩(데몬 최대 RSS를 낮추려고) 임베딩해 `vec_exchanges`에 넣고 `embedded=1`로 바꾼다. 모델이 준비되지 않았으면 건너뛴다. 문서 텍스트는 `passage: User: <user>\n\nAssistant: <assistant>\n\nTools: <tool_names>`를 2000자에서 자른 것이다. 스레드는 `with_intra_threads(2)`.

**FTS terms**: `user_message`와 `assistant_message`를 이은 텍스트에서, 한글 음절이 연속된 구간을 2글자씩 겹쳐 자른 bigram("검색추천" → "검색 색추 추천")으로 바꾸고 **구간 양옆에 공백을 넣는다**. "API검색"을 unicode61이 `api검색` 한 토큰으로 묶지 않게 하려는 것이다("API검색" → "API 검색"). 한 글자짜리 한글 구간은 그대로 둔다. 나머지 문자는 그대로 둔다. 영어 토큰화·어간은 FTS5 `porter unicode61`이 처리한다.

**exchange 경계**: exchange 시작 메시지(아래 표)에서 시작해 다음 시작 메시지 직전에서 끝난다. 사이의 답변 텍스트는 `assistant_message`에, 도구 이름은 `tool_names`에 넣는다. 파싱할 수 없는 줄은 건너뛰고 로그를 남긴다.

| | Claude | Codex |
|---|---|---|
| 세션 정보 | 줄의 `sessionId`, `cwd`, `timestamp` | **첫 번째** `session_meta`의 `payload.id`, `payload.cwd`. fork된 rollout의 두 번째 `session_meta`(부모)는 무시 |
| exchange 시작 메시지 | `type=user`이고 `tool_result`가 아닌 항목 중 제외 대상이 아닌 것 | 1순위: `event_msg`의 `item_completed`에서 `item.type=UserMessage`. 이 이벤트가 없는 옛 rollout은 `event_msg`의 `user_message`, 그것도 없으면 `response_item`의 `message`, `role=user` 중 제외 대상이 아닌 것 |
| 제외 대상 | `isMeta=true`, `isCompactSummary=true`, `origin.kind`가 있고 `human`이 아님(task-notification, peer 등. 값이 없으면 제외하지 않는다), 내용이 `[Request interrupted by user`, `<local-command-`, `<bash-stdout>`, `<bash-stderr>`, `<teammate-message`, `Another Claude session sent a message:`로 시작 | (fallback일 때만) `# AGENTS.md instructions`, `<environment_context>`, `<codex_internal_context>`, `<user_instructions>`, `<recommended_plugins>`, `<skill>`로 시작 |
| 서브에이전트 시작 메시지 | (위와 같음. 서브에이전트 첫 프롬프트는 `origin`이 없다) | `source.subagent`가 있는 파일은 자기 `agent_path` 앞으로 온 `response_item`의 `agent_message`에서 시작한다. 그보다 앞의 `role=user` 항목(부모에게서 물려받은 맥락)은 무시한다 |
| 답변 | `type=assistant`의 `text` 블록, 그리고 `SubagentHandback` `tool_use`의 `input.message`(서브에이전트 최종 보고) | `response_item`의 `message`, `role=assistant` |
| 도구 | `tool_use` ↔ 다음 user의 `tool_result`(`tool_use_id`로 짝) | `function_call`·`custom_tool_call`·`local_shell_call` ↔ 각 `*_output`(`call_id`로 짝) |
| sidechain | `isSidechain=true` 또는 경로가 `subagents/` 아래 | `session_meta.payload.source.subagent`가 있음 |

제외 규칙은 코드의 상수 한 곳에 두고, 실제 transcript 픽스처로 테스트한다.

**project**: `files.cwd`로 `git -C <cwd> rev-parse --git-common-dir`을 실행해 그 상위 디렉터리 이름을 쓴다. 실패하거나 디렉터리가 없으면 `cwd`의 basename. `cwd`가 없으면 `unknown`. 파일당 한 번 계산하되, `cwd`를 아직 못 읽었으면(파일 머리가 `mode`·`last-prompt` 같은 cwd 없는 줄뿐이면) 다음 sync에서 세션 정보를 다시 읽고 다시 계산한다.

**기존 아카이브 들여오기** (데몬 첫 기동 때 자동, 그리고 1번의 새 원본 등록 때)
- 아카이브 디렉터리는 `claude-code-projects`, `claude-code-transcripts`, `codex-sessions`만 본다. 레거시 `claude-projects/`는 무시한다(실측상 모든 파일이 `claude-code-projects/`에 같은 상대경로로 있다). 이전 세대 파일(`*.gen-*.jsonl`)도 들여오지 않는다.
- 원본이 있고, 원본이 아카이브보다 크거나 같고, 아카이브의 마지막 4KB가 원본의 같은 위치와 같으면 `offset` = 아카이브 크기. 아니면 3번처럼 기존 아카이브를 세대로 보존하고 새로 시작한다.
- 원본이 없으면 `source_path`에 원본이 있었을 경로를 넣고 `offset` = 아카이브 크기로 등록한 뒤 아카이브만 파싱한다.
- 약 1만 개, 9.7GB 규모다. 파일마다 커밋하므로 중간에 데몬이 종료돼도 이어서 한다.

## 6. MCP 도구

서버 이름 `episodic-memory`. 도구 설명은 obra의 문구를 바탕으로, 줄인 입력에 맞게 고친다.

**`search`**

| 입력 | 형식 |
|---|---|
| `query` | 문자열, 또는 문자열 2~5개 배열(AND) |
| `limit` | 기본 10, 최대 50 |
| `after`, `before` | `YYYY-MM-DD`, 선택. 로컬 시간대 기준 날짜 |
| `project` | 정확히 일치, 선택 |

`N = max(50, limit * 3)`

1. **BM25**: query를 terms와 같은 방식으로 바꾸고, 토큰마다 `"…"`로 감싸(안의 `"`는 `""`) OR로 잇는다. 한 글자 한글 구간은 prefix 쿼리 `"검"*`로 바꾼다. `fts_vocab`에서 문서 빈도가 전체 exchange의 20%를 넘는 토큰("니다", "합니" 같은 어미)은 뺀다. 다 빠지면 가장 드문 토큰 하나를 남긴다. `fts_exchanges`를 `exchanges`와 rowid로 조인해 같은 필터를 걸고 `bm25()` 상위 N개. 따옴표 덕분에 `C++`, `foo-bar`, `a:b`가 FTS5 문법 오류를 내지 않는다.
2. **벡터**: `query: <query>`를 임베딩해 `vec_exchanges`에서 KNN N개. `project`, `after`/`before`는 메타데이터 조건으로 KNN 안에 건다.
3. **RRF**: `score = 0.4/(60+rank_bm25) + 0.6/(60+rank_vec)`. 한쪽에만 있으면 그쪽 항만 더한다. 그 뒤 BM25 순위 보너스를 더한다(1등 +0.01, 2등 +0.005, 3등 +0.0025, 4등 이하 0). 그래서 BM25에서만 1등인 정확한 키워드 일치(0.4/61 + 0.01 ≈ 0.0166)가 벡터에서만 1등인 결과(0.6/61 ≈ 0.0098)보다 위에 온다. 마지막으로 sidechain은 점수에 0.9를 곱한다.
4. 상위 `limit`개. 출력 점수는 1등 점수로 나눠 0~1로 맞춘 값이다.
5. **배열 query**(obra 방식): 개념마다 1~3을 BM25 300개, KNN 300개 후보로 돌린다(단일 query의 N과 별개). 같은 대화 안의 개념이 상위 `limit * 5` 밖으로 밀려 교집합이 사라지는 일을 막는다. 대화(`archive_path`) 단위로 묶어 모든 개념이 나온 대화만 남기고, 개념별 최고 점수의 평균 순으로 정렬한다. 대화마다 가장 점수가 높은 exchange 하나를 보여준다. 교집합이 비면 빈 결과.
6. **모델 준비 전**: BM25 순위만 쓰고 결과 첫 줄에 그 사실을 적는다.

**날짜와 시간대**: 결과의 날짜는 로컬 시간대(`chrono::Local`)로 표시한다. `after`는 그 날짜 로컬 00:00 이상(`ts >=`), `before`는 날짜+1일 로컬 00:00 미만(`ts <`)이며 둘 다 UTC 밀리초로 바꿔 쓴다. DST로 자정이 겹치면 이른 쪽을 쓴다. DST 건너뛰기로 그 날 자정이 없으면 15분씩 최대 3시간까지 앞으로 밀어 처음 존재하는 로컬 시각(예: 상파울루 2018-11-04는 01:00)을 쓰고, 그래도 없으면 UTC 자정을 쓴다.

출력(결과마다): `project`, 날짜(로컬), 점수, 사용자 메시지 앞 200자, 답변 앞 200자, `archive_path:line_start-line_end`.

**`read`**

| 입력 | 형식 |
|---|---|
| `path` | 아카이브 파일 경로 |
| `startLine`, `endLine` | 1부터, 선택 |

- 아카이브 원문을 마크다운으로 보여준다: 사용자 메시지, 답변, 도구 호출(입력과 결과).
- `path`를 정규화한 결과가 아카이브 디렉터리 밖이면 에러.
- 도구 입력과 결과는 항목마다 4KB에서 자른다.
- 출력은 최대 60KB(약 2만 토큰. Claude Code MCP 출력 기본 한도 25,000 토큰 아래). 넘으면 그 직전 줄에서 끊고, 마지막 줄에 이어 읽을 `startLine`을 적는다. 항목마다 잘리므로 한 줄은 항상 상한 안에 들어가고, 이어 읽기는 매번 최소 한 줄 앞으로 나간다.

## 7. 패키징

- `bin/episodic-memory`(bash 래퍼)가 실행할 바이너리를 정한다.
  1. `EPISODIC_MEMORY_BIN`이 있으면 그 경로
  2. `~/.config/episodic-memory/bin/episodic-memory-v{VER}`(VER는 plugin.json 버전)
  3. 없으면 GitHub Release에서 받아 sha256을 검증해 설치한다. 다운로드는 `flock`으로 하나만 돈다. 락을 기다린 쪽은 락을 잡은 뒤 2번을 다시 확인한다.
  4. 지원하지 않는 플랫폼(Intel Mac 등)이면 에러 메시지를 내고 종료한다. 훅에서 불렸으면 exit 0.
- 구버전 바이너리는 지우지 않는다.
- `hooks/hooks.json`: SessionStart(`startup|resume|clear|compact`) → `"${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/bin/episodic-memory" sync`. 기존 Stop 훅은 지운다. `.codex-plugin`도 같은 훅을 쓴다.
- `.mcp.json`은 그대로.
- 남김: 스킬 `remembering-conversations`, 에이전트 `search-conversation`. 새 도구 입력에 맞게 고친다.
- 지움: 스킬 `setup`, `doctor`(2단계에서 다시 만든다), 명령 `commands/`, TS 소스·빌드·의존성(`src/`, `dist/`, `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `node_modules/`), 실험 산출물(`experiments/`, `autoresearch*.md`).
- `CLAUDE.md`, `README.md`는 새 구조로 다시 쓴다.
- 의존성: `rusqlite`(bundled), `sqlite-vec` ≥ 0.1.9, `fastembed` 7.1(ort 정적 링크, pyke 사전빌드).
- 릴리스: semantic-release가 버전을 정하고 `Cargo.toml`과 plugin.json 2개를 맞춘다. `release.yml`이 aarch64-apple-darwin, x86_64/aarch64-unknown-linux-gnu로 빌드해 `.tar.gz`와 `.sha256`을 Release에 올린다.

## 8. 에러 처리

- `sync`는 항상 exit 0. 에러는 `logs/`에 남긴다.
- `EPISODIC_MEMORY_DISABLE=1`이면 `sync`가 즉시 종료한다.
- 파싱 실패 줄, 사라진 원본, 읽을 수 없는 파일은 그 단위만 건너뛰고 로그를 남긴다.
- 모델 다운로드·로드 실패는 데몬을 죽이지 않는다. BM25로 동작하고 다음 기동 때 다시 시도한다.
- 데몬에 연결할 수 없으면 `mcp`가 종료하고 호스트가 에러를 보여준다.
- 자체 환경변수는 내부·테스트용 3개만 둔다: `EPISODIC_MEMORY_DIR`, `EPISODIC_MEMORY_DISABLE`, `EPISODIC_MEMORY_BIN`. 호스트 변수 `CLAUDE_CONFIG_DIR`, `CODEX_HOME`은 원본 루트를 찾을 때 읽기만 한다.

## 9. 검증

**사전 준비** (구현 첫 단계): 이 기기에 Rust 툴체인이 없다. 설치한 뒤 `fastembed` 7.1 + `sqlite-vec` 0.1.9 + rusqlite bundled로 빈 바이너리가 빌드되고, e5-small 임베딩 1건과 메타데이터 필터 KNN 1건이 도는지 확인한다.

**성능 측정** (들여오기 구현 후): 실제 아카이브 전체를 들여온 DB에서 한글·영어·섞인 query 각 10개의 `search` p95 지연을 잰다. 목표는 500ms 이하(검색어 임베딩 포함). 넘으면 BM25·KNN 후보 수 N과 흔한 토큰 기준(20%)을 조정한다.

**단위 테스트**
- 파서: 실제 Claude·Codex transcript 샘플을 픽스처로 두고 exchange 경계, 제외 규칙(Claude `origin.kind`·`isCompactSummary`·bash 출력, Codex `UserMessage` 이벤트와 fallback), 도구 이름(`custom_tool_call` 포함), sidechain(Claude·Codex), Codex 서브에이전트(`agent_message` 시작, 물려받은 `role=user` 무시, fork 포함), fork의 첫 `session_meta`, DO NOT INDEX(사용자 메시지에서만)를 확인한다.
- terms: "검색을"로 "검색"이 든 exchange가, "검색추천"으로 "추천"이 든 exchange가, "API검색"이 든 exchange가 "검색"으로 찾아지는지. 한 글자 query(prefix), 흔한 bigram 제외와 전부 빠졌을 때의 처리.
- 검색: 특수문자 query, RRF(한쪽만 있는 경우 포함), sidechain 0.9, 배열 query 대화 단위 교집합.
- `read`: 마크다운 렌더링, 줄 범위, 60KB 상한, 항목별 4KB 자르기, 거대한 한 줄에서도 이어 읽기가 앞으로 나가는지, 아카이브 밖 경로 거부.

**통합 테스트**
- sync: 늘어난 부분만 append, 미완결 마지막 줄, 크기 같으면 건너뜀, 마지막 exchange 다시 만들기, 256KB 초과 건너뛰기.
- 불변식: append 후 커밋 전 중단을 흉내 내고(아카이브만 늘림) 다음 sync가 잘라내고 한 번만 붙이는지.
- 다시 써진 파일: 작아진 경우, 커졌지만 꼬리 4KB가 다른 경우 → 이전 세대 파일 그대로, 새 경로에 새 세대, exchange는 새 세대 기준. 새 세대 커밋 뒤 append 전 중단 → 다음 sync가 이어서 처리하고 이전 세대 파일은 그대로인지.
- 기존 아카이브 들여오기: 원본 있음(꼬리 같음/다름), 원본 없음, 레거시 `claude-projects/` 중복 건너뜀.
- 데몬: 클라이언트 3개 동시 기동 시 데몬 1개, sync 요청이 겹칠 때 한 번으로 합침, 버전이 다른 데몬 2개에서 sync 1개만, 유휴 종료.
- MCP 왕복: `initialize` → `tools/list`(도구 2개) → `tools/call`을 `mcp` 파이프를 거쳐 확인한다.
- 임베딩이 필요한 테스트는 `#[ignore]`로 분리하고 CI에서 별도 job으로 돌린다.

**E2E**
1. `EPISODIC_MEMORY_BIN=target/debug/episodic-memory claude --plugin-dir .`로 세션 1에서 작업한다(서브에이전트 1번 포함).
2. 세션 2를 시작한다(SessionStart → sync).
3. `search`로 세션 1의 작업을 찾고 `read`로 원문을 연다.
4. Codex로 1~3을 반복한다.

**배포 검증**: 4.0.0 Release 후 `EPISODIC_MEMORY_BIN` 없이 래퍼를 실행해 다운로드 → 체크섬 검증 → 실행까지 되는지 확인한다.

## 10. 2단계: `doctor`

1단계 E2E가 통과한 뒤 진행한다.

`episodic-memory doctor` 서브커맨드. 각 항목을 `ok` / `warn` / `fail`로 한 줄씩 출력하고, `fail`이 하나라도 있으면 exit 1.

| 항목 | 확인 |
|---|---|
| 바이너리 | 버전, 실행 경로, 플랫폼 지원 여부 |
| 데몬 | 소켓 연결 여부, 데몬 버전, 연결된 클라이언트 수, sync 진행 여부 |
| DB | 경로, `user_version`, files·exchanges 수, 임베딩 대기 수, skipped 파일 수 |
| 모델 | 다운로드·로드 여부 |
| 원본 루트 | §5의 루트 3개 존재 여부 |
| 최근 sync | `meta`의 마지막 sync 시각, 마지막 에러 |

- 데몬 상태는 새 연결 종류 `{"client":"status"}`로 받는다. 데몬은 JSON 한 줄을 돌려주고 연결을 닫는다. 데몬이 없으면 `warn`(띄우지 않는다).
- 스킬 `doctor`를 다시 만든다: 검색이 비거나 업그레이드 직후 `doctor`를 실행하고 결과를 해석하라는 내용.

**나중에 검토**: bigram 검색 정밀도가 부족하면 terms 생성 함수만 lindera(ko-dic) 형태소 분석으로 바꾼다. 스키마는 그대로이고 terms만 다시 만든다.
