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
| 원본 | 아카이브가 원본. `read`는 아카이브 원문을 보여준다 | obra 그대로. 호스트는 transcript를 30일 뒤 지운다 |
| 아카이브 복사 | 파일 전체가 아니라 offset 이후 추가분만 append | obra는 mtime이 바뀌면 파일 전체를 다시 복사한다(`sync.ts:146-162`) |
| 텍스트 검색 | `LIKE` AND | obra 그대로. FTS5 + 형태소 분석은 §10 |
| 벡터 필터 | sqlite-vec 메타데이터 컬럼으로 KNN 안에서 건다 | obra는 KNN 뒤에 필터해서 결과가 비는 문제를 over-fetch로 우회한다(obra#126) |
| 임베딩 모델 | multilingual-e5-small(384차원) | obra의 bge-small-en-v1.5는 영어 전용이다. 지금 레포가 쓰는 모델이다 |
| 런타임 | 상주 데몬 1개가 모델·검색·sync를 맡는다 | obra는 세션마다 MCP 서버가 모델을 따로 올린다 |
| 기록 트리거 | SessionStart 훅이 데몬에 sync를 요청한다. 주기적 스캔은 없다 | obra와 같은 시점 |
| MCP 도구 | `search`, `read` 2개. `search` 입력을 줄였다(§6) | obra에서 `mode`, `session_id`, `git_branch`, `include_sidechains`, `response_format` 제외 |
| project | git common-dir 상위 디렉터리 이름 | worktree가 같은 project로 묶인다(agentmemory#515) |
| 개인정보 | `DO NOT INDEX` 표시만. 마스킹 없음 | obra 그대로. 아카이브가 원문을 보관하므로 색인만 가려도 의미가 없다 |

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
- **sync 작업**: 데몬 안에서 한 번에 하나만 돈다. 도는 중에 요청이 오면 끝난 뒤 한 번 더 돈다. 요청이 여러 개 쌓여도 한 번으로 합친다.
- **mcp**: 소켓 연결에 실패하면 데몬을 detached로 띄우고 백오프하며 재시도한다. 10초 안에 연결하지 못하면 종료하고, 호스트가 MCP 서버 에러를 보여준다.
- **싱글턴**: `daemon-{VER}.lock`에 `flock`. 락을 못 잡은 쪽은 바로 종료한다.
- **유휴 종료**: 클라이언트 0개, sync 작업 없음 상태로 10분이 지나면 종료한다.
- **버전 교체**: 소켓·락이 버전별이다. 구버전 데몬은 클라이언트가 사라지면 스스로 종료한다.
- **모델**: 첫 기동 때 `models/`에 받는다. 받는 동안과 로드에 실패했을 때 `search`는 텍스트 검색만 하고, 임베딩은 모델이 준비된 뒤 따라잡는다.

## 4. 저장

위치: `~/.config/episodic-memory/` (`EPISODIC_MEMORY_DIR`로 바꿀 수 있다, 테스트용)

- 아카이브: `conversation-archive/<source_kind>/<원본 루트 기준 상대경로>`. 지금 레이아웃 그대로.
- DB: `episodic.db`(새 파일). 기존 `conversations.db`는 읽지도 지우지도 않는다.

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;

files(source_path TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,          -- claude-projects | claude-transcripts | codex-sessions
      archive_path TEXT NOT NULL UNIQUE,
      offset INTEGER NOT NULL DEFAULT 0,  -- 아카이브에 반영한 원본 바이트 수
      reparse_line INTEGER NOT NULL DEFAULT 1,  -- 다음 파싱을 시작할 아카이브 줄(1부터)
      project TEXT,                       -- 첫 파싱 때 한 번 계산
      skipped INTEGER NOT NULL DEFAULT 0) -- DO NOT INDEX

exchanges(id INTEGER PRIMARY KEY,
          archive_path TEXT NOT NULL,
          line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
          session_id TEXT,
          git_branch TEXT,                 -- 2단계 필터용. 1단계부터 채운다
          project TEXT NOT NULL,
          harness TEXT NOT NULL,           -- claude | codex
          is_sidechain INTEGER NOT NULL DEFAULT 0,
          ts INTEGER NOT NULL,             -- unix ms, 사용자 메시지 시각
          user_message TEXT NOT NULL,
          assistant_message TEXT NOT NULL, -- 그 턴의 답변 텍스트를 빈 줄로 이은 것
          tool_names TEXT NOT NULL DEFAULT '',  -- 쉼표로 이은 도구 이름
          embedded INTEGER NOT NULL DEFAULT 0)
CREATE INDEX exchanges_file ON exchanges(archive_path, line_start);
CREATE INDEX exchanges_pending ON exchanges(id) WHERE embedded = 0;

tool_calls(id INTEGER PRIMARY KEY,
           exchange_id INTEGER NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
           tool_name TEXT NOT NULL, tool_input TEXT, tool_result TEXT,
           is_error INTEGER NOT NULL DEFAULT 0)

CREATE VIRTUAL TABLE vec_exchanges USING vec0(
  embedding float[384],
  project TEXT, ts INTEGER, is_sidechain INTEGER,
  session_id TEXT, git_branch TEXT);   -- rowid = exchanges.id. 마지막 두 컬럼은 2단계 필터용
```

- vec0는 나중에 메타데이터 컬럼을 추가할 수 없으므로 2단계 필터 컬럼(`session_id`, `git_branch`)도 1단계부터 넣고 채운다.

- `PRAGMA foreign_keys=ON`. vec0는 FK를 지원하지 않으므로 exchange를 지울 때 같은 트랜잭션에서 `vec_exchanges` 행도 지운다.
- 스키마 버전은 `PRAGMA user_version`. 마이그레이션은 추가만 한다.

## 5. sync

**발견**: 아래 루트 아래의 `*.jsonl`을 재귀로 찾아 크기만 `stat`한다. 깨진 심볼릭 링크와 읽을 수 없는 파일은 건너뛴다.

| source_kind | 루트 |
|---|---|
| claude-projects | `$CLAUDE_CONFIG_DIR/projects` 또는 `~/.claude/projects` (서브에이전트 `<session>/subagents/agent-*.jsonl` 포함) |
| claude-transcripts | `~/.claude/transcripts` (있을 때만) |
| codex-sessions | `$CODEX_HOME/sessions` 또는 `~/.codex/sessions` |

**파일 하나 처리** (트랜잭션은 파일 단위)
1. 원본 크기 > `offset`이면 `offset`부터 마지막 개행까지를 아카이브에 append하고 `offset`을 올린다. 미완결 마지막 줄은 다음 sync로 넘긴다.
2. 원본 크기 < `offset`이면(파일이 다시 써짐) 아카이브를 원본으로 통째로 덮어쓰고, 그 파일의 exchange를 지우고, `offset = 원본 크기`, `reparse_line = 1`로 되돌린다.
3. `skipped=1`이면 여기서 끝낸다.
4. 아카이브를 `reparse_line`부터 끝까지 파싱한다. 먼저 그 파일에서 `line_start >= reparse_line`인 exchange를 지운다.
5. 파싱한 exchange를 넣는다. 마지막 exchange의 `line_start`를 새 `reparse_line`으로 둔다. 마지막 exchange는 아직 진행 중일 수 있어 다음 sync에서 다시 만든다.
6. 사용자 메시지에 `<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>`가 있으면 `skipped=1`로 바꾸고 그 파일의 exchange를 모두 지운다. 도구 출력이나 답변에 나온 표시는 무시한다.
7. `user_message`나 `assistant_message`가 256KB를 넘는 exchange는 넣지 않고 개수만 로그에 남긴다(obra#139).

**임베딩**: 모든 파일을 처리한 뒤 `embedded=0`인 exchange를 32개씩 임베딩해 `vec_exchanges`에 넣고 `embedded=1`로 바꾼다. 문서 텍스트는 `passage: User: <user>\n\nAssistant: <assistant>\n\nTools: <tool_names>`를 2000자에서 자른 것이다. ort 스레드는 최대 2개(obra#124).

**exchange 경계**
- 사용자가 입력한 메시지(도구 결과가 아닌 user 항목)에서 시작해, 다음 사용자 메시지 직전에서 끝난다.
- 사이의 답변 텍스트는 `assistant_message`에, 도구 호출과 결과는 `tool_calls`에 넣는다.
- Claude: `isSidechain`이 참이거나 경로가 `subagents/` 아래면 `is_sidechain=1`. `sessionId`, `cwd`, `gitBranch`, `timestamp`를 줄에서 읽는다.
- Codex: rollout의 `session_meta`에서 세션 id, `cwd`, git branch를 읽고, `response_item`의 user/assistant 메시지와 함수 호출·결과(`local_shell_call_output` 포함)를 짝짓는다.
- 파싱할 수 없는 줄은 건너뛰고 로그를 남긴다.

**project**: 파일에서 처음 나온 `cwd`로 `git -C <cwd> rev-parse --git-common-dir`을 실행해 그 상위 디렉터리 이름을 쓴다. 실패하거나 디렉터리가 없으면 `cwd`의 basename. `cwd`가 없으면 `unknown`.

**기존 아카이브 들여오기** (데몬 첫 기동 때 자동)
- 아카이브에는 있고 `files`에 없는 파일을 등록한다.
- 원본이 있고, 원본이 아카이브보다 크거나 같고, 아카이브의 마지막 4KB가 원본의 같은 위치와 같으면 `offset` = 아카이브 크기. 아니면 2번처럼 원본으로 덮어쓴다.
- 원본이 없으면 `source_path`에 원본이 있었을 경로를 넣고, 아카이브만 파싱한다.
- 12,784개, 9.7GB 규모다. 파일마다 커밋하므로 중간에 데몬이 종료돼도 이어서 한다.

## 6. MCP 도구

서버 이름 `episodic-memory`. 도구 설명은 obra의 문구를 바탕으로, 줄인 입력에 맞게 고친다.

**`search`**

| 입력 | 형식 |
|---|---|
| `query` | 문자열, 또는 문자열 2~5개 배열(AND) |
| `limit` | 기본 10, 최대 50 |
| `after`, `before` | `YYYY-MM-DD`, 선택 |
| `project` | 정확히 일치, 선택 |

1. **벡터**: `query: <query>`를 임베딩해 `vec_exchanges`에서 KNN `limit`개. `project`, `after`/`before`는 메타데이터 컬럼 조건으로 KNN 안에 건다. 정렬은 `distance + is_sidechain * 0.05`(obra 그대로). 점수는 `1 - d²/2`(obra#55).
2. **텍스트**: query를 공백으로 나눈 단어마다 `(user_message LIKE ? OR assistant_message LIKE ?)`를 AND로 건다. `%`, `_`, `\`는 이스케이프한다. 같은 필터를 걸고 `is_sidechain, ts DESC` 순으로 `limit`개.
3. **합치기**: 벡터 결과 뒤에 텍스트 결과 중 새 것을 붙이고 `limit`개로 자른다. 텍스트로만 찾은 결과는 점수 대신 `text`로 표시한다.
4. **배열 query**: 개념마다 1~3을 돌려 모든 결과에 나온 exchange만 남기고, 벡터 점수 평균 순으로 정렬한다. 교집합이 비면 빈 결과.
5. **모델 준비 전**: 텍스트 검색만 하고 결과 첫 줄에 그 사실을 적는다.

출력(결과마다): `project`, 날짜, 점수, 사용자 메시지 앞 200자, 답변 앞 200자, `archive_path:line_start-line_end`.

**`read`**

| 입력 | 형식 |
|---|---|
| `path` | 아카이브 파일 경로 |
| `startLine`, `endLine` | 1부터, 선택 |

- 아카이브 원문을 마크다운으로 보여준다: 사용자 메시지, 답변, 도구 호출(입력과 결과).
- `path`를 정규화한 결과가 아카이브 디렉터리 밖이면 에러.
- 범위가 없으면 파일 전체. 도구 설명에 긴 대화는 `search` 결과의 줄 범위로 나눠 읽으라고 적는다.

## 7. 패키징

- `bin/episodic-memory`(bash 래퍼)가 실행할 바이너리를 정한다.
  1. `EPISODIC_MEMORY_BIN`이 있으면 그 경로
  2. `~/.config/episodic-memory/bin/episodic-memory-v{VER}`(VER는 plugin.json 버전)
  3. 없으면 GitHub Release에서 받아 sha256을 검증해 설치한다. 다운로드는 `flock`으로 하나만 돈다. 락을 기다린 쪽은 락을 잡은 뒤 2번을 다시 확인한다.
- 구버전 바이너리는 지우지 않는다.
- `hooks/hooks.json`: SessionStart(`startup|resume|clear|compact`) → `"${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/bin/episodic-memory" sync`. 기존 Stop 훅은 지운다. `.codex-plugin`도 같은 훅을 쓴다.
- `.mcp.json`은 그대로.
- 남김: 스킬 `remembering-conversations`, 에이전트 `search-conversation`. 새 도구 입력에 맞게 고친다.
- 지움: 스킬 `setup`, `doctor`, 명령 `commands/`, TS 소스·빌드·의존성(`src/`, `dist/`, `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `node_modules/`), 실험 산출물(`experiments/`, `autoresearch*.md`).
- `CLAUDE.md`, `README.md`는 새 구조로 다시 쓴다.
- 릴리스: semantic-release가 버전을 정하고 `Cargo.toml`과 plugin.json 2개를 맞춘다. `release.yml`이 aarch64/x86_64-apple-darwin, x86_64/aarch64-unknown-linux-gnu로 빌드해 `.tar.gz`와 `.sha256`을 Release에 올린다. ort는 정적 링크한다.

## 8. 에러 처리

- `sync`는 항상 exit 0. 에러는 `logs/`에 남긴다.
- `EPISODIC_MEMORY_DISABLE=1`이면 `sync`가 즉시 종료한다.
- 파싱 실패 줄, 사라진 원본, 읽을 수 없는 파일은 그 단위만 건너뛰고 로그를 남긴다.
- 모델 다운로드·로드 실패는 데몬을 죽이지 않는다. 텍스트 검색으로 동작하고 다음 기동 때 다시 시도한다.
- 데몬에 연결할 수 없으면 `mcp`가 종료하고 호스트가 에러를 보여준다.
- 자체 환경변수는 내부·테스트용 3개만 둔다: `EPISODIC_MEMORY_DIR`, `EPISODIC_MEMORY_DISABLE`, `EPISODIC_MEMORY_BIN`. 호스트 변수 `CLAUDE_CONFIG_DIR`, `CODEX_HOME`은 원본 루트를 찾을 때 읽기만 한다.

## 9. 검증

**사전 측정** (구현 첫 단계, 결과에 따라 이 스펙을 고친다)
1. fastembed-rs(또는 ort 직접)로 multilingual-e5-small을 돌릴 수 있는지, 지금 레포 임베딩과 같은 벡터가 나오는지.
2. Rust에서 sqlite-vec vec0 메타데이터 컬럼 필터(`WHERE embedding MATCH ? AND k = ? AND project = ?`)가 되는지. 안 되면 obra처럼 over-fetch(`limit * 3`) 후 필터로 간다.

**단위 테스트**
- 파서: 실제 Claude·Codex transcript 샘플을 픽스처로 두고 exchange 경계, 도구 짝짓기, sidechain 표시, DO NOT INDEX(사용자 메시지에서만)를 확인한다.
- 검색: LIKE AND와 이스케이프, 배열 query 교집합, sidechain 감점, 텍스트 결과 합치기.
- `read`: 마크다운 렌더링, 줄 범위, 아카이브 밖 경로 거부.

**통합 테스트**
- sync: 늘어난 부분만 append, 미완결 마지막 줄, 다시 써진 파일, 마지막 exchange 다시 만들기, 256KB 초과 건너뛰기.
- 기존 아카이브 들여오기: 원본 있음(앞부분 같음/다름), 원본 없음.
- 데몬: 클라이언트 3개 동시 기동 시 데몬 1개, sync 요청이 겹칠 때 한 번으로 합침, 유휴 종료.
- MCP 왕복: `initialize` → `tools/list`(도구 2개) → `tools/call`을 `mcp` 파이프를 거쳐 확인한다.
- 임베딩이 필요한 테스트는 `#[ignore]`로 분리하고 CI에서 별도 job으로 돌린다.

**E2E**
1. `EPISODIC_MEMORY_BIN=target/debug/episodic-memory claude --plugin-dir .`로 세션 1에서 작업한다(서브에이전트 1번 포함).
2. 세션 2를 시작한다(SessionStart → sync).
3. `search`로 세션 1의 작업을 찾고 `read`로 원문을 연다.
4. Codex로 1~3을 반복한다.

**배포 검증**: 4.0.0 Release 후 `EPISODIC_MEMORY_BIN` 없이 래퍼를 실행해 다운로드 → 체크섬 검증 → 실행까지 되는지 확인한다.

## 10. 2단계

1단계 E2E가 통과한 뒤 진행한다. 세 항목은 서로 독립이라 순서를 바꿔도 된다.

### 10.1 FTS5 + lindera + RRF

`LIKE` 텍스트 검색을 형태소 분석 BM25로 바꾸고, 벡터와 가중 RRF로 합친다.

**스키마 추가**
```sql
CREATE VIRTUAL TABLE fts_exchanges USING fts5(terms, content='', contentless_delete=1,
       tokenize='porter unicode61 remove_diacritics 2');   -- rowid = exchanges.id
ALTER TABLE exchanges ADD COLUMN fts_indexed INTEGER NOT NULL DEFAULT 0;
```
- **terms**: `user_message`와 `assistant_message`를 이어, 한글 구간은 lindera + ko-dic으로 형태소를 나눠 공백으로 잇고 나머지는 그대로 둔 문자열. 영어 어간은 FTS5 porter가 처리한다. 원문 대신 terms만 색인한다.
- **색인 시점**: sync가 exchange를 넣는 같은 트랜잭션에서 terms를 계산해 넣고 `fts_indexed=1`. 모델이 필요 없다.
- **기존 행 백필**: 마이그레이션 직후 데몬이 `fts_indexed=0`인 행을 500개씩 백그라운드로 채운다. 그동안 그 행은 `LIKE`로 찾는다.
- **삭제**: exchange를 지우는 모든 경로에서 `fts_exchanges`의 같은 rowid도 지운다(§4의 vec0와 같은 방식).

**검색** (§6의 1~3을 대체)
1. query를 terms와 같은 방식으로 나눈다. 토큰마다 `"…"`로 감싸고(안의 `"`는 `""`) OR로 이어 `bm25()` 상위 50. 따옴표 덕분에 `C++`, `foo-bar`, `a:b`가 FTS5 문법 오류를 내지 않는다.
2. 벡터 KNN 상위 50(§6과 같은 필터).
3. 가중 RRF: `score = 0.4/(60+rank_bm25) + 0.6/(60+rank_vec)`(agentmemory `hybrid-search.ts:20,30-31`). 한쪽에만 있으면 그쪽 항만 더한다.
4. sidechain은 RRF 점수에 0.9를 곱한다.
5. 상위 `limit`개. 출력 점수는 RRF 점수를 상위 1등 기준 0~1로 나눈 값.
- 배열 query: 개념마다 1~5를 돌려 교집합을 RRF 점수 평균으로 정렬한다.
- 모델 준비 전: BM25 순위만 쓴다.
- `LIKE` 검색 코드는 백필이 끝난 다음 릴리스에서 지운다.

**사전 측정**: `embed-ko-dic`으로 사전을 바이너리에 넣었을 때 크기 증가분. 50MB를 넘으면 모델처럼 첫 실행 때 `models/`로 받는다.

**테스트**: "검색을"로 "검색"이 있는 exchange가 찾아지는지, "검색추천"으로 "추천"이 찾아지는지, 특수문자 query, RRF 계산(한쪽만 있는 경우 포함), sidechain 0.9, 백필 중 혼합 검색.

### 10.2 `doctor`

`episodic-memory doctor` 서브커맨드. 각 항목을 `ok` / `warn` / `fail`로 한 줄씩 출력하고, `fail`이 하나라도 있으면 exit 1.

| 항목 | 확인 |
|---|---|
| 바이너리 | 버전, 실행 경로 |
| 데몬 | 소켓 연결 여부, 데몬 버전, 연결된 클라이언트 수, sync 진행 여부 |
| DB | 경로, `user_version`, files·exchanges 수, 임베딩 대기 수, FTS 대기 수, skipped 파일 수 |
| 모델 | 다운로드·로드 여부 |
| 원본 루트 | §5의 루트 3개 존재 여부 |
| 최근 sync | 마지막 sync 시각, 마지막 에러(로그 마지막 줄) |

- 데몬 상태는 새 연결 종류 `{"client":"status"}`로 받는다. 데몬은 JSON 한 줄을 돌려주고 연결을 닫는다. 데몬이 없으면 `warn`(띄우지 않는다).
- 마지막 sync 시각과 에러는 데몬이 DB의 `meta(key TEXT PRIMARY KEY, value TEXT)` 테이블에 남긴다.
- 스킬 `doctor`를 다시 만든다: 검색이 비거나 업그레이드 직후 `doctor`를 실행하고 결과를 해석하라는 내용.

### 10.3 `session_id`, `git_branch` 검색 필터

- `search` 입력에 `session_id`, `git_branch`(둘 다 정확히 일치, 선택)를 추가한다.
- 컬럼은 1단계부터 `exchanges`와 `vec_exchanges`에 채워져 있으므로(§4) 스키마 변경이 없다. 벡터는 KNN 메타데이터 조건으로, 텍스트(LIKE 또는 FTS)는 `exchanges` WHERE로 건다.
- 출력에 `session_id`를 추가해, 찾은 세션으로 다시 좁혀 검색할 수 있게 한다.
- 테스트: 필터별 결과가 해당 값만 포함하는지, 필터와 `project`·날짜 조합.
