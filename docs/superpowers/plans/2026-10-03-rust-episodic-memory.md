# Rust episodic-memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use core:subagent-driven-development (recommended) or core:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** episodic-memory를 TypeScript/mem0에서 Rust 단일 바이너리(데몬 + FTS5 bigram/벡터 RRF 검색 + 아카이브 append)로 교체해 4.0.0으로 내고, 이어서 `doctor`를 4.x로 추가한다.

**Architecture:** 바이너리 하나에 서브커맨드 `sync`/`mcp`/`daemon`(2단계에 `doctor`). 데몬이 버전별 유닉스 소켓에서 MCP JSON-RPC와 sync 요청을 받고, sync 작업이 transcript를 아카이브에 append → exchange 파싱 → SQLite(FTS5, sqlite-vec)에 쓴다. 검색은 BM25와 KNN을 가중 RRF로 합친다.

**Tech Stack:** Rust stable(edition 2021), rusqlite(bundled), sqlite-vec ≥ 0.1.9, fastembed 7.1(`MultilingualE5Small`), serde_json, clap, fs2(flock), chrono, sha2 없음(래퍼가 `shasum`/`sha256sum` 사용).

**Spec:** `docs/superpowers/specs/2026-10-03-rust-episodic-memory-design.md` (§ 번호는 이 문서 기준)

## Global Constraints

- 데이터 디렉터리 `~/.config/episodic-memory/`, `EPISODIC_MEMORY_DIR`로 바꿈. 아카이브 `conversation-archive/<source_kind>/<상대경로>`, DB `episodic.db`. 기존 `conversations.db`는 열지 않는다.
- source_kind 문자열: `claude-code-projects`, `claude-code-transcripts`, `codex-sessions`. 레거시 `claude-projects/`와 `*.gen-*.jsonl`은 들여오지 않는다.
- 자체 환경변수는 `EPISODIC_MEMORY_DIR`, `EPISODIC_MEMORY_DISABLE`, `EPISODIC_MEMORY_BIN` 3개뿐. 호스트 변수 `CLAUDE_CONFIG_DIR`, `CODEX_HOME`은 읽기만. 테스트 전용 조절은 숨김 CLI 플래그로 한다.
- 소켓 `<data>/daemon-<VER>.sock`, 데몬 락 `<data>/daemon-<VER>.lock`, sync 락 `<data>/sync.lock`(버전 무관). `VER = env!("CARGO_PKG_VERSION")`.
- SQLite: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`. DB 쓰기는 sync 작업만.
- 임베딩: 384차원, 문서 `passage: User: <u>\n\nAssistant: <a>\n\nTools: <t>`를 2000자(char)에서 자름, 검색어 `query: <q>`. 배치 32, `with_intra_threads(2)`.
- 상수: exchange 메시지 상한 262144바이트, 꼬리 비교 4096바이트, 유휴 종료 600초, mcp 연결 재시도 총 10초, `read` 출력 상한 61440바이트, 항목 상한 4096바이트, 검색 `limit` 기본 10·최대 50, `N = max(50, limit*3)`, 배열 query 개념당 `limit*5`, RRF `0.4/(60+r_bm25) + 0.6/(60+r_vec)`, sidechain ×0.9, 흔한 토큰 기준 문서 빈도 > 20%.
- DO NOT INDEX 표시: `<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>`, exchange 시작 메시지에서만 찾는다.
- `sync`는 항상 exit 0. 에러는 `<data>/logs/episodic-memory.log`에 append.
- 지원 타깃: `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`.
- **레포는 public이다.** 테스트 픽스처는 실제 transcript 구조를 흉내 낸 합성 데이터로 만든다. 실제 대화 내용을 커밋하지 않는다.

## Review Focus

1. **긴 데이터 디렉터리 경로**: macOS 유닉스 소켓 경로 한도(104바이트)를 넘으면 bind가 실패한다. 데몬은 로그에 원인을 남기고 종료하고, `mcp`는 10초 뒤 "socket path too long" 메시지로 종료해야 한다 → Task 11에 테스트.
2. **transcript 중간의 깨진 줄**(잘린 JSON, 잘못된 UTF-8): 그 줄만 건너뛰고 나머지 exchange는 만들어져야 한다 → Task 4·5에 테스트.
3. **빈 query, 공백만, 흔한 토큰만 있는 query**: 에러가 아니라 빈 결과(또는 벡터 결과만)를 돌려줘야 한다 → Task 9에 테스트.
4. **아카이브 파일이 외부에서 지워진 경우**: sync는 새 세대로 복구하고, 원본도 없으면 그 파일만 건너뛰며, `read`는 "file not found" 에러 텍스트를 돌려줘야 한다 → Task 7·10에 테스트.
5. **sync 도중의 검색**: WAL에서 검색이 막히거나 부분 커밋 상태를 보면 안 된다(파일 단위 트랜잭션) → Task 11에 테스트.

---

## 파일 구조

```
Cargo.toml
src/main.rs            clap: sync | mcp | daemon (| doctor)
src/paths.rs           Paths, SourceKind, source_roots()
src/log.rs             log_line()
src/db.rs              open(), 스키마, delete_exchanges_from(), insert_exchange(), FileRow
src/terms.rs           to_terms(), build_match_query()
src/parse/mod.rs       FileMeta, ParsedExchange, ParseOutput, read_meta(), parse_from()
src/parse/claude.rs
src/parse/codex.rs
src/project.rs         resolve_project()
src/archive.rs         archive_path_for(), append_tail(), tails_match()
src/sync.rs            discover(), sync_file(), import_archive(), index_file(), embed_pending(), run_sync()
src/embed.rs           Embedder trait, E5Embedder, FakeEmbedder
src/search.rs          search(), rrf()
src/read.rs            read_archive()
src/mcp.rs             serve() JSON-RPC
src/daemon.rs          run()
src/client.rs          connect_or_spawn(), run_mcp(), run_sync_hook()
tests/fixtures/{claude,codex}/*.jsonl   합성 픽스처
tests/*.rs             통합 테스트
bin/episodic-memory    bash 래퍼
scripts/sync-versions.sh
```

---

# 1단계 (4.0.0)

### Task 1: 툴체인, 스켈레톤, TS 제거, 의존성 확인

**Files:**
- Delete: `src/`(TS 전체), `dist/`, `package.json`, `package-lock.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `node_modules/`, `scripts/*`(전부), `tests/*`(전부), `hooks/hooks.test.ts`, `test-all.sh`, `experiments/`, `autoresearch*.md`, `.orphaned_at`, `commands/`, `skills/setup/`, `skills/doctor/`
- Create: `Cargo.toml`, `src/main.rs`, `tests/smoke.rs`
- Modify: `.github/workflows/ci.yml`, `.gitignore`(`target/` 추가, `node_modules`·`dist` 항목 제거)

**Interfaces:**
- Produces: 크레이트 이름 `episodic-memory`, 바이너리 `episodic-memory`. `Cargo.toml` version은 `3.2.0`(semantic-release가 올린다).

- [ ] **Step 1:** `rustup`으로 stable 설치(`curl https://sh.rustup.rs -sSf | sh -s -- -y`), `cargo --version` 확인.
- [ ] **Step 2:** 위 Delete 목록을 `git rm -r`로 지운다. `bin/`, `hooks/hooks.json`, `.mcp.json`, `skills/remembering-conversations/`, `agents/`, 플러그인 매니페스트, `docs/`는 남긴다.
- [ ] **Step 3:** `Cargo.toml` 의존성: `rusqlite`(최신, `features = ["bundled"]`, SQLite ≥ 3.43 확인), `sqlite-vec = "0.1.9"`, `fastembed = "7.1"`, `serde = { features = ["derive"] }`, `serde_json`, `clap = { features = ["derive"] }`, `fs2`, `chrono`, `anyhow`. dev: `tempfile`. `[profile.release] lto = true, strip = true`.
- [ ] **Step 4: 스모크 테스트 작성** `tests/smoke.rs`

```rust
#[test]
fn fts5_contentless_delete_and_vec0_metadata_knn() {
    // sqlite3_auto_extension(sqlite_vec::sqlite3_vec_init) 등록 후 :memory: 연결
    // 1) fts5(content='', contentless_delete=1) 생성, rowid 1 insert, DELETE WHERE rowid=1 성공
    // 2) vec0(embedding float[384], project TEXT, ts INTEGER) 에 2행(project "a","b") insert
    //    SELECT rowid FROM v WHERE embedding MATCH ? AND k = 5 AND project = 'a'  → [1]
    assert_eq!(rows, vec![1]);
}

#[test]
#[ignore] // 모델 다운로드 필요
fn e5_small_embeds_384() {
    // fastembed TextEmbedding::try_new(InitOptions::new(EmbeddingModel::MultilingualE5Small)
    //   .with_cache_dir(tmp)) → embed(vec!["passage: 안녕"]) → len 384, L2 norm ≈ 1.0 (±1e-3)
}
```
- [ ] **Step 5:** `cargo test` → smoke 통과. `cargo test -- --ignored e5_small_embeds_384` → 통과(모델 다운로드). 실패하면 멈추고 스펙 §9 사전 준비 결과로 보고한다.
- [ ] **Step 6:** `ci.yml`을 `dtolnay/rust-toolchain@stable` + `cargo fmt --check` + `cargo clippy -- -D warnings` + `cargo test`로 교체. 별도 job `embed`에서 `cargo test -- --ignored`(모델 캐시 `actions/cache`).
- [ ] **Step 7: Commit** `git commit -m "feat!: replace TypeScript implementation with Rust skeleton"` 본문에 `BREAKING CHANGE: Rust rewrite; mem0 LLM extraction removed, new episodic.db`.

### Task 2: 경로와 로깅

**Files:** Create `src/paths.rs`, `src/log.rs`

**Interfaces:**
- Produces:
  - `pub struct Paths { pub data: PathBuf }`, `Paths::from_env() -> Paths`, `Paths::new(data: PathBuf) -> Paths`
  - 메서드(모두 `-> PathBuf`): `archive_root()`, `db()`, `models()`, `logs()`, `daemon_socket()`, `daemon_lock()`, `sync_lock()`
  - `pub enum SourceKind { ClaudeCodeProjects, ClaudeCodeTranscripts, CodexSessions }`, `as_str(&self) -> &'static str`, `harness(&self) -> &'static str`(`"claude"`/`"codex"`), `ALL: [SourceKind; 3]`
  - `pub struct SourceRoot { pub kind: SourceKind, pub root: PathBuf }`, `pub fn source_roots() -> Vec<SourceRoot>`(존재하는 루트만)
  - `pub fn log_line(paths: &Paths, msg: &str)`(실패해도 패닉 없음, `[RFC3339] msg\n`)

- [ ] **Step 1: 테스트**: `EPISODIC_MEMORY_DIR=/tmp/x` → `db() == /tmp/x/episodic.db`, `daemon_socket()`가 `daemon-<CARGO_PKG_VERSION>.sock`으로 끝남, `sync_lock()`에 버전이 없음. `CLAUDE_CONFIG_DIR`가 있으면 `<it>/projects`, 없으면 `~/.claude/projects`. `CODEX_HOME` 동일. `log_line`이 `logs/episodic-memory.log`에 한 줄 추가.
- [ ] **Step 2:** 실패 확인 → 구현 → `cargo test paths log` 통과.
- [ ] **Step 3: Commit** `feat: add data paths and file logging`

### Task 3: DB 스키마

**Files:** Create `src/db.rs`

**Interfaces:**
- Produces:
  - `pub fn open(path: &Path) -> anyhow::Result<Connection>` — sqlite-vec 등록(프로세스당 1회, `std::sync::Once`), PRAGMA, `user_version` 0이면 스펙 §4 스키마 + `fts_vocab` 생성 후 1로.
  - `pub struct FileRow { source_path, source_kind: String, archive_path: String, generation: i64, offset: i64, reparse_line: i64, session_id: Option<String>, cwd: Option<String>, project: Option<String>, harness: Option<String>, is_sidechain: Option<bool>, user_signal: Option<String>, skipped: bool }` + `get_file(&Connection, source_path) -> Result<Option<FileRow>>`, `upsert_file(&Transaction, &FileRow) -> Result<()>`
  - `pub struct NewExchange { archive_path, line_start, line_end, session_id: Option<String>, project, harness, is_sidechain: bool, ts: i64, user_message, assistant_message, tool_names: String }`
  - `pub fn insert_exchange(tx: &Transaction, e: &NewExchange, terms: &str) -> Result<i64>` — `exchanges`와 `fts_exchanges`(같은 rowid)에 넣는다.
  - `pub fn delete_exchanges_from(tx: &Transaction, archive_path: &str, from_line: i64) -> Result<usize>` — exchange 삭제의 **유일한** 경로. 대상 id를 모아 `fts_exchanges`, `vec_exchanges`를 먼저 지우고 `exchanges`를 지운다.
  - `pub fn meta_set(&Connection, key, value)`, `meta_get(&Connection, key) -> Option<String>`
- 스펙 대비 추가: `files.user_signal TEXT` — Codex 사용자 메시지 신호(`item_completed`/`user_message`/`response_item`)를 파일 첫 파싱 때 정해 저장한다(중간부터 파싱해도 같은 규칙을 쓰기 위해).

- [ ] **Step 1: 테스트** `open_creates_schema_once`(두 번 열어도 `user_version == 1`), `insert_then_delete_cleans_fts_and_vec`(exchange 2개 insert + vec 행 수동 insert → `delete_exchanges_from(path, 1)` → 세 테이블 모두 0행), `delete_from_line_keeps_earlier`(line_start 1, 10 → from 5 삭제 → 1만 남음), `autoincrement_does_not_reuse_ids`(insert→delete→insert 시 새 id가 더 큼).
- [ ] **Step 2:** 실패 확인 → 구현 → 통과.
- [ ] **Step 3: Commit** `feat: add SQLite schema with FTS5 and sqlite-vec`

### Task 4: terms와 MATCH 쿼리

**Files:** Create `src/terms.rs`

**Interfaces:**
- Produces:
  - `pub fn to_terms(text: &str) -> String` — 한글 음절(U+AC00–U+D7A3) 연속 구간을 bigram으로, 구간 양옆에 공백. 1글자 구간은 그대로.
  - `pub fn query_tokens(query: &str) -> Vec<QueryToken>` / `pub enum QueryToken { Term(String), Prefix(String) }` — `to_terms`를 거친 뒤 unicode61과 같은 기준(영숫자 연속)으로 나누고 소문자화. 1글자 한글 구간은 `Prefix`.
  - `pub fn build_match_query(conn: &Connection, query: &str) -> Result<Option<String>>` — 토큰마다 `"…"`(내부 `"`→`""`), Prefix는 `"검"*`, OR로 잇는다. `fts_vocab`(`SELECT doc FROM fts_vocab WHERE term=?`)로 문서 빈도 > 20%×전체 exchange 수인 토큰은 뺀다. 다 빠지면 doc이 가장 작은 하나를 남긴다. 토큰이 없으면 `None`.

- [ ] **Step 1: 테스트**

```rust
// norm(s) = s.split_whitespace().collect::<Vec<_>>().join(" ")
assert_eq!(norm(to_terms("검색추천")), "검색 색추 추천");
assert_eq!(norm(to_terms("API검색")), "API 검색");
assert_eq!(norm(to_terms("가 나")), "가 나");
assert_eq!(norm(to_terms("sync 버그를")), "sync 버그 그를");
// FTS 왕복: 문서 "검색추천 기능", "API검색 수정" 색인 후
//   build_match_query("추천") → 1번 문서, "검색" → 두 문서, "검" → prefix로 두 문서
//   "C++ foo-bar a:b \"x\"" → Ok(Some(_)), MATCH 실행 시 에러 없음
//   흔한 토큰: 문서 10개 중 9개에 "니다" → query "합니다 추천" 에서 "니다"가 빠짐
//   query "   " → None
```
- [ ] **Step 2:** 실패 확인 → 구현 → `cargo test terms` 통과.
- [ ] **Step 3: Commit** `feat: add Korean bigram terms and FTS match query`

### Task 5: 파서 공통 + Claude

**Files:** Create `src/parse/mod.rs`, `src/parse/claude.rs`, `tests/fixtures/claude/{main.jsonl,subagent.jsonl,noise.jsonl}`

**Interfaces:**
- Produces:
  - `pub struct FileMeta { pub session_id: Option<String>, pub cwd: Option<String>, pub is_sidechain: bool, pub agent_path: Option<String>, pub user_signal: Option<String> }`
  - `pub struct ParsedExchange { pub line_start: i64, pub line_end: i64, pub ts: i64, pub user_message: String, pub assistant_message: String, pub tool_names: Vec<String> }`
  - `pub struct ParseOutput { pub exchanges: Vec<ParsedExchange>, pub do_not_index: bool, pub bad_lines: usize }`
  - `pub fn read_meta(kind: SourceKind, archive: &Path, rel_path: &str) -> Result<FileMeta>` — 파일 머리부터 필요한 값을 찾을 때까지 읽는다.
  - `pub fn parse_from(kind: SourceKind, archive: &Path, from_line: i64, meta: &FileMeta) -> Result<ParseOutput>`
  - `pub const DO_NOT_INDEX: &str`
- Claude 규칙은 스펙 §5 표 그대로. 제외 규칙은 `claude.rs`의 상수 한 곳. 메시지 텍스트: `content`가 문자열이면 그대로, 배열이면 `text` 블록을 `\n`로 잇는다. `ts`는 줄 `timestamp`(RFC3339) → ms. 마지막 exchange의 `line_end`는 그 exchange에 속한 마지막 줄.

- [ ] **Step 1: 픽스처 작성.** 로컬 `~/.claude/projects`의 실제 파일을 `jq`로 훑어 구조(필드 이름·중첩)를 맞추되 내용은 합성으로 쓴다. `main.jsonl`: 사람 메시지 3개, 그 사이 `tool_use`/`tool_result`, 답변 text 블록 2개짜리 턴 하나. `noise.jsonl`: `isMeta`, `isCompactSummary`, `origin.kind="task-notification"`, `origin.kind="human"`, `[Request interrupted by user]`, `<bash-stdout>`, 잘린 JSON 한 줄, DO NOT INDEX가 tool_result 안에만 있는 경우. `subagent.jsonl`: `isSidechain:true`, 첫 프롬프트에 `origin` 없음.
- [ ] **Step 2: 테스트**: `main` → exchange 3개, 두 번째의 `tool_names == ["Bash","Read"]`(픽스처 기준), 답변 2블록이 `\n\n`로 이어짐, `line_start/line_end` 정확. `parse_from(.., from_line=<2번째 exchange line_start>)` → 2개. `noise` → 제외 대상이 경계를 만들지 않음(exchange 수 = human 메시지 수), `bad_lines == 1`, `do_not_index == false`. user 메시지에 DO NOT INDEX가 있는 변형 → `true`. `subagent` → `read_meta(..).is_sidechain == true`, 경로가 `x/subagents/agent-1.jsonl`이면 플래그 없어도 true.
- [ ] **Step 3:** 실패 확인 → 구현 → `cargo test parse::claude` 통과.
- [ ] **Step 4: Commit** `feat: parse Claude Code transcripts into exchanges`

### Task 6: Codex 파서

**Files:** Create `src/parse/codex.rs`, `tests/fixtures/codex/{modern.jsonl,legacy.jsonl,subagent.jsonl,fork.jsonl}`

**Interfaces:**
- Consumes: Task 5의 타입과 `read_meta`/`parse_from` 디스패치.
- `read_meta`: 첫 `session_meta`의 `payload.id`, `payload.cwd`, `payload.source.subagent`(있으면 `is_sidechain=true`, `agent_path = subagent.thread_spawn.agent_path`). `user_signal`: 파일 전체에서 `event_msg/item_completed`의 `item.type=="UserMessage"`가 있으면 `"item_completed"`, 없고 `event_msg/user_message`가 있으면 `"user_message"`, 아니면 `"response_item"`.
- 시작 메시지·제외 접두어·서브에이전트 규칙·도구 짝(`function_call`/`custom_tool_call`/`local_shell_call` ↔ `*_output`, `call_id`)은 스펙 §5 표 그대로. 답변은 `response_item` `message` `role=assistant`의 `output_text`.

- [ ] **Step 1: 픽스처**(실제 `~/.codex/sessions` 구조를 `jq`로 확인 후 합성): `modern`(item_completed UserMessage 2개 + 같은 내용의 response_item role=user 중복 + AGENTS.md 주입 + custom_tool_call 2쌍), `legacy`(event 없이 response_item role=user만, `<environment_context>` 주입 포함), `subagent`(source.subagent, 앞쪽 role=user 물려받은 맥락, agent_path 앞으로 온 agent_message에서 시작), `fork`(session_meta 2줄, 둘째가 부모 id).
- [ ] **Step 2: 테스트**: `modern` → exchange 2개(중복 response_item이 경계를 만들지 않음), `tool_names`에 custom 도구 이름. `legacy` → 주입 메시지 제외, exchange 수 = 사람 메시지 수. `subagent` → `is_sidechain`, 첫 exchange의 `user_message`가 agent_message 내용, 물려받은 role=user 미포함. `fork` → `session_id`가 첫 줄의 id.
- [ ] **Step 3:** 실패 확인 → 구현 → `cargo test parse::codex` 통과.
- [ ] **Step 4: Commit** `feat: parse Codex rollouts including subagents and forks`

### Task 7: 아카이브 미러링 (append, 불변식, 세대)

**Files:** Create `src/archive.rs`, `src/project.rs`; Create `src/sync.rs`(이 Task에서는 `sync_file`의 미러링 부분까지)

**Interfaces:**
- Produces:
  - `pub fn archive_path_for(paths: &Paths, kind: SourceKind, rel: &Path, generation: i64) -> PathBuf` — gen 0은 원래 이름, N≥1은 `<stem>.gen-<N>.jsonl`.
  - `pub fn append_tail(src: &Path, dst: &Path, offset: u64) -> io::Result<u64>` — `dst`를 `offset`으로 맞춘 상태라고 가정하고, `src[offset..마지막 '\n']`을 append + fsync, 새 offset 반환(완결 줄 없으면 그대로).
  - `pub fn tails_match(src: &Path, dst: &Path, offset: u64) -> io::Result<bool>` — `[offset-4096, offset)`(offset<4096이면 0부터) 비교.
  - `pub fn resolve_project(cwd: Option<&str>) -> String` — 스펙 §5 project 규칙.
  - `pub struct DiscoveredFile { pub kind: SourceKind, pub source_path: PathBuf, pub rel: PathBuf, pub size: u64 }`
  - `pub fn sync_file(conn: &mut Connection, paths: &Paths, f: &DiscoveredFile) -> Result<FileOutcome>`; `pub enum FileOutcome { Unchanged, Synced { new_exchanges: usize }, Skipped }`
- 흐름은 스펙 §5 "파일 하나 처리" 1~10. 3번 새 세대는 append 전에 별도 트랜잭션으로 커밋. 파싱(7번)은 Task 8의 `index_file`을 호출하므로, 이 Task에서는 `index_file`을 "offset만 올리는" 임시 구현으로 둔다.

- [ ] **Step 1: 테스트**(tempdir, 원본 파일을 직접 써서): `appends_only_tail`(원본 2줄 → sync → 아카이브 2줄, 원본에 1줄 추가 → 아카이브 3줄, 원본 전체 복사 아님을 아카이브 inode 동일로 확인), `holds_incomplete_last_line`(개행 없는 끝 줄은 다음 sync까지 미반영), `unchanged_size_skips`, `truncates_crashed_append`(아카이브 끝에 쓰레기 바이트 추가 → sync → offset 크기로 잘린 뒤 한 번만 붙음), `shrunk_source_starts_new_generation`(원본을 더 작게 다시 씀 → 기존 아카이브 바이트 그대로, `archive_path`가 `.gen-1.jsonl`, generation 1), `rewritten_tail_starts_new_generation`(크기는 커졌지만 꼬리 4KB가 다름), `crash_after_generation_commit_recovers`(새 세대 커밋 후 새 경로에 부분 파일을 남긴 상태 → sync → 정상, gen-0 파일 그대로), `archive_deleted_externally_recovers`(아카이브 파일 삭제 → 새 세대로 다시 채움). `resolve_project`: git worktree 디렉터리 → 메인 레포 이름, 없는 경로 `/x/y/proj` → `proj`, `None` → `unknown`.
- [ ] **Step 2:** 실패 확인 → 구현 → `cargo test archive sync::mirror project` 통과.
- [ ] **Step 3: Commit** `feat: mirror transcripts into archive with append-only generations`

### Task 8: 색인 (파싱 → exchanges)

**Files:** Modify `src/sync.rs`

**Interfaces:**
- Consumes: `read_meta`, `parse_from`, `insert_exchange`, `delete_exchanges_from`, `to_terms`, `resolve_project`.
- Produces: `pub fn index_file(tx: &Transaction, row: &mut FileRow, kind: SourceKind) -> Result<usize>` — 스펙 §5 6~9: `skipped`면 0. 세션 정보가 비었으면 `read_meta`로 채우고 `project` 계산. `delete_exchanges_from(archive_path, reparse_line)` 후 `parse_from(reparse_line)` 결과를 넣는다(256KB 초과는 건너뛰고 개수를 `log_line`). `do_not_index`면 `skipped=true` + `delete_exchanges_from(path, 1)`. 마지막 exchange의 `line_start`를 `reparse_line`으로.

- [ ] **Step 1: 테스트**: `reindexes_only_last_exchange`(3개 → 원본에 턴 추가 → 첫 두 exchange의 id 불변, 마지막은 새 id, 총 4개), `do_not_index_skips_and_purges`(색인된 파일에 DO NOT INDEX 턴 추가 → exchange 0, 이후 append돼도 0), `oversize_exchange_skipped`(user_message 300KB → 그 exchange만 없음), `fts_row_per_exchange`(`SELECT count(*) FROM fts_exchanges` 대신 MATCH로 각 exchange 검색됨), `bad_line_does_not_abort`.
- [ ] **Step 2:** 실패 확인 → 구현 → 통과.
- [ ] **Step 3: Commit** `feat: index archived transcripts into exchanges`

### Task 9: 임베딩, 발견, 들여오기, run_sync

**Files:** Create `src/embed.rs`; Modify `src/sync.rs`

**Interfaces:**
- Produces:
  - `pub trait Embedder: Send + Sync { fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>; fn embed_query(&self, q: &str) -> Result<Vec<f32>>; }` — 접두어(`passage: `/`query: `)는 구현체가 붙인다.
  - `pub struct E5Embedder` — `E5Embedder::load(models_dir: &Path) -> Result<Self>`(fastembed `MultilingualE5Small`, `with_cache_dir`, `with_intra_threads(2)`).
  - `pub struct FakeEmbedder` — 토큰 해시를 384차원에 더하고 L2 정규화. 같은 단어가 있으면 가깝다.
  - `pub fn embed_pending(conn: &mut Connection, e: &dyn Embedder) -> Result<usize>` — 32개씩, 문서 텍스트 2000 char 자름, `vec_exchanges`(rowid, embedding, project, ts, is_sidechain) insert + `embedded=1` 한 트랜잭션.
  - `pub fn discover() -> Vec<DiscoveredFile>` — `source_roots()` 재귀, `*.jsonl`, 깨진 링크·읽기 실패 건너뜀.
  - `pub fn import_archive(conn: &mut Connection, paths: &Paths) -> Result<usize>` — 스펙 §5 들여오기. 파일마다 등록 + `index_file` + 커밋. 끝나면 `meta_set("imported","1")`.
  - `pub fn run_sync(paths: &Paths, embedder: Option<&dyn Embedder>) -> Result<SyncStats>` — `sync.lock` `try_lock_exclusive` 실패 시 `Ok(SyncStats::skipped())`. `imported` 없으면 `import_archive`. `discover` → `sync_file` 각각(에러는 로그 후 계속) → `embedder`가 있으면 `embed_pending` → `meta_set("last_sync", RFC3339)`, `sync_count` 1 증가, 에러 있으면 `meta_set("last_error", ..)`.

- [ ] **Step 1: 테스트**: `fake_embedder_similarity`(같은 단어 문장끼리 내적이 다른 문장보다 큼), `embed_pending_marks_and_inserts`, `import_registers_existing_archive`(원본 있음+꼬리 같음 → offset=아카이브 크기, 원본 append 후 sync는 꼬리만 붙임 / 꼬리 다름 → gen-1 / 원본 없음 → 아카이브만 파싱되어 exchange 생성), `import_skips_legacy_and_generations`(`claude-projects/a.jsonl`, `claude-code-projects/b.gen-1.jsonl` 무시), `run_sync_respects_sync_lock`(다른 핸들이 락을 잡은 상태 → skipped), `run_sync_without_embedder_leaves_pending`.
- [ ] **Step 2:** 실패 확인 → 구현 → 통과.
- [ ] **Step 3: Commit** `feat: add embedding pass, archive import, and sync orchestration`

### Task 10: 검색과 read

**Files:** Create `src/search.rs`, `src/read.rs`

**Interfaces:**
- Produces:
  - `pub struct SearchParams { pub queries: Vec<String>, pub limit: usize, pub after: Option<NaiveDate>, pub before: Option<NaiveDate>, pub project: Option<String> }` — `after`는 그날 00:00 UTC 이상, `before`는 그날 다음 날 00:00 UTC 미만(그날 포함).
  - `pub struct Hit { pub exchange_id: i64, pub project: String, pub ts: i64, pub score: f64, pub user_snippet: String, pub assistant_snippet: String, pub archive_path: String, pub line_start: i64, pub line_end: i64 }`
  - `pub struct SearchOutput { pub hits: Vec<Hit>, pub vector_used: bool }`
  - `pub fn search(conn: &Connection, e: Option<&dyn Embedder>, p: &SearchParams) -> Result<SearchOutput>`
  - `pub fn rrf(bm25: &[i64], vec: &[i64], sidechain: &HashSet<i64>) -> Vec<(i64, f64)>`
  - `pub fn read_archive(paths: &Paths, path: &str, start: Option<usize>, end: Option<usize>) -> Result<String>`
- 검색 알고리즘은 스펙 §6 1~6. 배열 query는 `archive_path`로 묶고 개념별 최고 점수 평균. 스니펫은 앞 200 char.
- `read`: `path`를 `canonicalize` 후 `archive_root()` 밑인지 확인. kind는 경로의 첫 컴포넌트로. 줄마다 파서의 렌더링 헬퍼로 `**User:**` / `**Assistant:**` / `**Tool <name>:** <input>` / `**Result:** <output>`(입력·결과 각 4096바이트에서 자르고 `…[truncated]`). 61440바이트를 넘기기 직전 줄에서 멈추고 `_(continue with startLine=<n>)_`.

- [ ] **Step 1: 테스트(search)**: `rrf_weights`(bm25=[1,2], vec=[2,3] → id 2 점수 = 0.4/62+0.6/61 이 최대, id 3은 0.6/62만), `sidechain_penalty`, `bm25_only_without_embedder`(`vector_used=false`), `project_and_date_filters_apply_to_both`(FakeEmbedder), `multi_concept_intersects_by_conversation`(개념 A는 exchange 1, 개념 B는 같은 파일의 exchange 2에서만 → 결과 1개; 다른 파일이면 0개), `empty_and_noise_queries_return_empty`(`""`, `"   "`, `"!!!"` → `Ok`, hits 비어 있음 또는 벡터 결과만), `limit_capped_at_50`.
- [ ] **Step 2: 테스트(read)**: 픽스처 렌더링에 User/Assistant/Tool 포함, `startLine/endLine` 범위, 100KB 도구 결과 → 4096바이트로 잘림, 줄 1000개 파일 → 출력 ≤ 61440바이트이고 continue 안내의 startLine이 이전 호출의 startLine보다 큼, `../../etc/passwd` → 에러, 없는 파일 → `file not found` 에러.
- [ ] **Step 3:** 실패 확인 → 구현 → `cargo test search read` 통과.
- [ ] **Step 4: Commit** `feat: add hybrid RRF search and archive reader`

### Task 11: MCP, 데몬, 클라이언트

**Files:** Create `src/mcp.rs`, `src/daemon.rs`, `src/client.rs`; Modify `src/main.rs`; Test `tests/daemon.rs`

**Interfaces:**
- Consumes: `search`, `read_archive`, `run_sync`, `E5Embedder`/`FakeEmbedder`, `Paths`, `log_line`.
- Produces:
  - `pub struct Ctx { pub paths: Paths, pub embedder: Arc<RwLock<Option<Arc<dyn Embedder>>>> }`
  - `pub fn serve(r: impl BufRead, w: impl Write, ctx: &Ctx) -> Result<()>` — 줄 단위 JSON-RPC 2.0. `initialize`(클라이언트 `protocolVersion`을 그대로 돌려줌, `serverInfo {name:"episodic-memory", version: VER}`), `notifications/*` 무시, `tools/list`(도구 2개: `search` 입력 `query`(string 또는 string 배열 2~5), `limit`, `after`, `before`, `project` / `read` 입력 `path`, `startLine`, `endLine`; 설명은 obra `mcp-server.ts:146-185` 문구를 줄인 입력에 맞게 고침), `tools/call`(결과를 `content: [{type:"text", text}]`, 입력 오류는 `isError: true`), 그 외 메서드는 `-32601`.
  - `search` 텍스트 형식: 모델 준비 전이면 첫 줄 `(vector search unavailable: model loading — keyword results only)`. 결과마다 `N. [project, YYYY-MM-DD, score 0.87]\n   User: …\n   Assistant: …\n   <archive_path>:<start>-<end>`.
  - `pub fn daemon::run(paths: Paths, opts: DaemonOpts) -> Result<()>`; `pub struct DaemonOpts { pub idle_secs: u64, pub fake_embedder: bool }`(숨김 플래그 `--idle-secs`, `--fake-embedder`)
  - `pub fn client::connect_or_spawn(paths: &Paths, total: Duration) -> Result<UnixStream>`, `pub fn run_mcp(paths: &Paths) -> Result<()>`, `pub fn run_sync_hook(paths: &Paths)`(반환값 없음, 항상 성공)
- 데몬 동작은 스펙 §3. 구현 선택: 연결마다 스레드, DB 연결은 스레드마다 `db::open`. 스케줄러는 `Mutex<{running: bool, pending: bool}>` + `Condvar`. 모델 로더 스레드가 `std::env::remove_var("HF_HOME")` 후 `E5Embedder::load`, 성공 시 `embedder`에 넣고 sync 요청. 소켓 경로가 100바이트를 넘으면 `log_line` 후 종료. 데몬 락을 잡은 뒤에만 남은 소켓 파일을 지우고 bind. 유휴 감시 스레드가 1초마다 확인.
- 데몬 spawn: `Command::new(current_exe()).arg("daemon")`, stdio null, `process_group(0)`. `mcp`는 50ms부터 두 배씩 최대 500ms 간격으로 10초 재시도.

- [ ] **Step 1: 단위 테스트(mcp)**: 메모리 버퍼로 `initialize` → `tools/list`(이름이 정확히 `["search","read"]`) → `tools/call search`(FakeEmbedder, 픽스처 색인 DB) → 텍스트에 archive 경로 포함, 잘못된 `limit: "x"` → `isError`, 모르는 메서드 → `-32601`.
- [ ] **Step 2: 통합 테스트** `tests/daemon.rs`(바이너리를 `env!("CARGO_BIN_EXE_episodic-memory")`로 실행, `EPISODIC_MEMORY_DIR`는 `/tmp/em-<rand>` 같은 짧은 경로, `CLAUDE_CONFIG_DIR`/`CODEX_HOME`을 픽스처 사본으로):
  - `three_mcp_clients_one_daemon`: `mcp` 3개 동시 실행 → 3개 모두 `tools/list` 응답. 이어서 `episodic-memory daemon`을 직접 실행하면 데몬 락을 못 잡아 1초 안에 exit 0.
  - `sync_hook_triggers_indexing`: `sync` 실행(exit 0 즉시) → 2초 안에 `search` 결과 등장(FakeEmbedder).
  - `sync_requests_coalesce`: 첫 sync가 끝난 뒤 `sync` 10번 연속 → `meta sync_count` 증가분 ≤ 2.
  - `different_version_daemons_share_sync_lock`: `sync.lock`을 테스트가 잡은 상태에서 `sync` → `last_sync` 갱신 안 됨, 해제 후 갱신.
  - `idle_exit`: `--idle-secs 2`로 띄우고 클라이언트 없이 4초 → 소켓 연결 실패.
  - `search_during_sync_sees_committed_state`: 큰 픽스처 sync 도중 반복 검색 → 에러 없음, 결과 exchange는 모두 DB에 존재.
  - `long_socket_path_fails_cleanly`: 120바이트 데이터 경로 → `mcp`가 10초 안에 0이 아닌 코드로 종료, 로그에 `socket path too long`.
  - `disable_env_short_circuits`: `EPISODIC_MEMORY_DISABLE=1 episodic-memory sync` → exit 0, 데몬 미기동.
- [ ] **Step 3:** 실패 확인 → 구현 → `cargo test --test daemon` 통과.
- [ ] **Step 4: Commit** `feat: add daemon, MCP server, and sync hook client`

### Task 12: 패키징, 문서, 릴리스

**Files:**
- Modify: `bin/episodic-memory`(bash로 재작성), `hooks/hooks.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`(설명 문구), `skills/remembering-conversations/SKILL.md`, `skills/remembering-conversations/MCP-TOOLS.md`, `agents/search-conversation.md`, `CLAUDE.md`, `README.md`, `.releaserc.json`, `.github/workflows/release.yml`
- Create: `scripts/sync-versions.sh`, `tests/wrapper.bats`

**Interfaces:**
- 래퍼 순서는 스펙 §7. VER는 `../.claude-plugin/plugin.json`에서 `sed`로 읽는다(jq 의존 없음). 타깃 매핑: `Darwin arm64`→`aarch64-apple-darwin`, `Linux x86_64`→`x86_64-unknown-linux-gnu`, `Linux aarch64|arm64`→`aarch64-unknown-linux-gnu`, 그 외 → `episodic-memory: unsupported platform <os>/<arch>`를 stderr, 첫 인자가 `sync`면 exit 0 아니면 1.
- 다운로드: `https://github.com/baleen37/episodic-memory/releases/download/v${VER}/episodic-memory-v${VER}-${TARGET}.tar.gz`와 `.sha256`, `flock <data>/bin/.install.lock`, 검증은 `shasum -a 256 -c` 또는 `sha256sum -c`, 임시 경로에 풀고 `mv`로 설치.
- 릴리스 자산 이름: `episodic-memory-v<VER>-<target>.tar.gz`(안에 `episodic-memory` 하나) + `.sha256`.

- [ ] **Step 1: 테스트** `tests/wrapper.bats`: `EPISODIC_MEMORY_BIN=/path/to/stub` → 그 stub이 인자 그대로 실행됨. `EPISODIC_MEMORY_DIR` 밑 `bin/episodic-memory-v<VER>` stub이 있으면 다운로드 없이 실행됨. `uname` stub로 `Darwin x86_64` → `sync`는 exit 0 + 메시지, `mcp`는 exit 1.
- [ ] **Step 2:** 래퍼 재작성 → `bats tests/wrapper.bats` 통과.
- [ ] **Step 3:** `hooks/hooks.json`에서 Stop 훅 삭제, SessionStart 명령을 `"${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/bin/episodic-memory" sync`로. `.mcp.json`은 변경 없음 확인.
- [ ] **Step 4:** 스킬·에이전트 문구를 새 도구(`search` 입력 5개, `read`의 `path`/`startLine`/`endLine`, 결과의 `archive_path:start-end`를 `read`로 열기)에 맞춘다. "event/fact memory records", `id`로 인용 같은 옛 표현 제거. plugin.json 설명에서 "extracts ... memory records" 제거.
- [ ] **Step 5:** `CLAUDE.md`를 새 구조로 다시 쓴다(명령은 `cargo test`/`cargo build --release`, Key Files는 위 파일 구조, Data Flow는 스펙 §3·§5 요약, 픽스처 합성 원칙). `README.md`: 설치, 지원 플랫폼(Intel Mac 미지원), DO NOT INDEX 사용법, Codex Desktop 훅 수동 설정 안내, 4.0.0 마이그레이션(기존 `conversations.db`는 안 쓰며 지워도 됨, 아카이브 재사용).
- [ ] **Step 6:** `scripts/sync-versions.sh <ver>`: `Cargo.toml`의 `[package] version`과 plugin.json 2개의 `.version`을 바꾼다. `.releaserc.json` `prepareCmd`를 `bash scripts/sync-versions.sh ${nextRelease.version}`로, git assets를 `Cargo.toml`, `Cargo.lock`, plugin.json 2개로.
- [ ] **Step 7:** `release.yml`: job `release`(Node로 `npx -p semantic-release -p @semantic-release/exec -p @semantic-release/git semantic-release`, 실행 전후 `git tag --points-at HEAD`로 새 버전을 output) → job `build`(needs release, 버전이 있을 때만, matrix `macos-14`/aarch64-apple-darwin, `ubuntu-22.04`/x86_64-unknown-linux-gnu, `ubuntu-22.04-arm`/aarch64-unknown-linux-gnu): `git checkout v<VER>` → `cargo build --release --target` → tar.gz + sha256 → `gh release upload v<VER>`. `GITHUB_TOKEN`으로 만든 태그는 다른 워크플로를 트리거하지 않으므로 같은 워크플로 안에서 빌드한다. `on-release.yml`은 그대로.
- [ ] **Step 8:** `cargo test && bats tests/wrapper.bats` 통과 확인.
- [ ] **Step 9: Commit** `feat: package Rust binary as plugin with release pipeline`

### Task 13: 성능 측정과 E2E

**Files:** Create `docs/superpowers/reports/2026-10-rust-episodic-memory-e2e.md`

- [ ] **Step 1: 실데이터 들여오기.** `EPISODIC_MEMORY_DIR=/tmp/em-real`에 실제 아카이브를 복사(`cp -c`로 APFS clone, 원본 디렉터리는 건드리지 않음) 후 `cargo run --release -- daemon --idle-secs 60`, `sync` 실행. 기록: 들여오기 소요 시간, files/exchanges 수, 임베딩 소요 시간, DB 크기.
- [ ] **Step 2: 지연 측정.** 한글·영어·섞인 query 각 10개로 `search` p95(검색어 임베딩 포함)를 잰다. 목표 500ms 이하. 넘으면 `N`과 20% 기준을 조정해 다시 재고 값을 보고서에 남긴다.
- [ ] **Step 3: E2E Claude.** 스펙 §9 E2E 1~3(`EPISODIC_MEMORY_BIN=target/release/episodic-memory claude --plugin-dir .`, 세션 1에서 서브에이전트 1번 포함). 결과(찾은 결과 카드, `read` 출력 일부)를 보고서에 붙인다.
- [ ] **Step 4: E2E Codex.** 같은 순서.
- [ ] **Step 5: Commit** `docs: record Rust episodic-memory e2e and latency results`
- [ ] **Step 6:** main으로 PR. 머지 후 4.0.0 Release가 나오면 스펙 §9 배포 검증(래퍼 다운로드 → 체크섬 → 실행)을 하고 결과를 보고서에 추가.

---

# 2단계 (4.x): `doctor`

### Task 14: `doctor` 서브커맨드와 스킬

**Files:** Create `src/doctor.rs`, `skills/doctor/SKILL.md`; Modify `src/daemon.rs`, `src/main.rs`, `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: `Paths`, `db::open`, `meta_get`, `source_roots`.
- Produces:
  - 데몬 연결 종류 `{"client":"status"}` → 데몬이 `{"version", "clients", "sync_running", "model": "ready"|"loading"|"failed"}` 한 줄을 쓰고 닫는다.
  - `pub enum Level { Ok, Warn, Fail }`, `pub struct Check { pub name: &'static str, pub level: Level, pub detail: String }`
  - `pub fn run_checks(paths: &Paths) -> Vec<Check>`; `main`이 `[ok] name: detail` 형식으로 출력, `Fail`이 있으면 exit 1.
- 항목은 스펙 §10 표. 판정: 데몬 없음 `Warn`(띄우지 않음), DB 열기 실패 `Fail`, 모델 `failed` `Fail`·`loading` `Warn`, 원본 루트가 하나도 없음 `Fail`, `last_error` 있음 `Warn`, 임베딩 대기 > 0 `Warn`.

- [ ] **Step 1: 테스트**: 빈 데이터 디렉터리 → DB `Ok`(생성), 데몬 `Warn`, 원본 루트 없음 `Fail`, exit 1. 픽스처로 sync한 뒤 데몬 띄움 → 데몬 `Ok`(버전 일치), exchanges 수 > 0. `meta last_error` 설정 → `Warn`. status 연결이 데몬을 띄우지 않음.
- [ ] **Step 2:** 실패 확인 → 구현 → `cargo test doctor` 통과.
- [ ] **Step 3:** `skills/doctor/SKILL.md`: 검색 결과가 비거나 업그레이드 직후 `"${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/bin/episodic-memory" doctor`를 실행하고, `fail`/`warn` 줄마다 원인과 조치(데몬 없음 → 새 세션 시작, 모델 loading → 첫 다운로드 대기, 원본 루트 없음 → `CLAUDE_CONFIG_DIR`/`CODEX_HOME` 확인)를 설명하라는 내용. CLAUDE.md·README에 `doctor` 추가.
- [ ] **Step 4: Commit** `feat: add doctor diagnostics`
