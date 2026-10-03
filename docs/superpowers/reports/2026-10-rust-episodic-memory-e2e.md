# Rust episodic-memory: 실데이터 성능 측정과 E2E (Task 13)

측정일 2026-10-04. 기기: Apple M4 Pro, 48GB RAM, macOS 15 (Darwin 24.4).
바이너리: `cargo build --release` (커밋 `68554cf` 기준). 바이너리가 내는 버전 3.2.0은 릴리스 전이라
아직 올리지 않은 `Cargo.toml` 버전이다(4.0.0은 semantic-release가 올린다). 모든 실행은
`EPISODIC_MEMORY_DIR=/tmp/...`로 격리했고 `~/.config/episodic-memory`에는 쓰지 않았다.

## 요약

| 항목 | 결과 | 목표 |
|---|---|---|
| `search` p95 (한글/영어/섞음, 각 10개) | 31.9 / 39.2 / 36.9 ms | 500 ms 이하 |
| 들여오기 (파일 10,423개, exchange 35,083개) | 약 250 s | - |
| 임베딩 (35,083개) | 약 1,980 s (17.7개/s) | - |
| DB 크기 | 291 MB | - |
| E2E Claude (`claude -p --plugin-dir`) | 통과 (hook, MCP, 서브에이전트 포함) | - |
| E2E Codex (`codex exec`) | MCP 통과, hook은 수동 실행으로 대체 | - |

지연은 목표보다 10배 이상 낮다. `N`(50)과 흔한 토큰 기준(20%)은 바꾸지 않았다.

## 1. 실데이터 들여오기

준비:

1. 실제 아카이브를 APFS clone으로 복사: `cp -c -R ~/.config/episodic-memory/conversation-archive /tmp/em-real/conversation-archive`.
   레거시 `claude-projects/`는 들여오기 대상이 아니라서 clone에서 지웠다.
2. 모델 캐시(`models--intfloat--multilingual-e5-small`)도 clone해서 `/tmp/em-real/models/`에 두었다. 다운로드는 없었다.
3. `episodic-memory daemon --idle-secs 3600`을 띄우고 `episodic-memory sync`를 보냈다.
   소스 루트는 실제 `~/.claude/projects`, `~/.codex/sessions`(읽기만 함).

결과:

| 단계 | 값 |
|---|---|
| 아카이브 파일 | claude-code-projects 6,567 / codex-sessions 3,856 (합 10,423, skipped 0) |
| exchange | 35,083 (claude 21,169, codex 13,914, sidechain 11,693) |
| 들여오기 + 첫 sync | 약 250 s (약 42 파일/s). 모델 로드(캐시 있음, 약 1 s)는 별도 스레드에서 이 시간 안에 병렬로 끝나서 이 값에 거의 영향이 없다. 임베딩은 첫 sync가 끝난 뒤 시작한다 |
| 임베딩 | 252 s → 2,233 s, 35,083개, 약 17.7개/s (intra threads 2, batch 32) |
| 전체 검색 가능까지 | 2,233 s (약 37분) |
| DB | `episodic.db` 305,479,680 bytes (291 MB), 체크포인트 뒤 WAL 0 |
| `meta.last_error` | 빈 값 |

데몬 메모리(RSS, `ps`):

| 시점 | RSS |
|---|---|
| 들여오기 중 | 약 1.9 GB |
| 임베딩 중 | 4.2~4.3 GB |
| 임베딩 끝난 뒤 유휴 | 4.3 GB (줄지 않음) |
| 새로 띄운 데몬, 모델 로드 후 유휴 | 1.8 GB |

## 2. 검색 지연

실제 MCP 경로로 쟀다: `episodic-memory mcp`를 띄워 `initialize` 후 `tools/call search`를
보내고 응답 한 줄이 올 때까지의 시간(클라이언트 측). 검색어 임베딩 포함, limit 10, 데몬 warm.
query는 실제 사용과 비슷한 일반 문자열이다.

- 한글: 검색 품질, 임베딩 모델 다운로드, 데몬 종료 시간, 한글 형태소 분석, 테스트 실패 원인,
  배포 롤백 절차, 권한 설정 변경, 커밋 메시지 규칙, 메모리 누수 디버깅, 성능 측정 결과
- 영어: daemon idle exit, sqlite vector search, release workflow checksum, flaky test retry,
  rate limit backoff, git worktree cleanup, MCP server initialize, hook timeout error,
  embedding batch size, typescript build error
- 섞음: sqlite-vec 메타데이터 필터, SessionStart hook 동작, BM25 점수 정규화, Rust 바이너리 배포,
  Codex rollout 파싱, MCP 도구 설명, opensearch 인덱스 매핑, Jira 티켓 생성, PR 리뷰 코멘트,
  embedding 모델 로딩

| 그룹 | p50 | p95 | max |
|---|---|---|---|
| 한글 | 29.1 ms | 31.9 ms | 31.9 ms |
| 영어 | 26.5 ms | 39.2 ms | 39.2 ms |
| 섞음 | 30.5 ms | 36.9 ms | 36.9 ms |

(1회차 측정도 p95 30.7~38.7 ms로 같은 범위였다.)
30개 query 모두 결과 10개, 벡터 사용(keyword-only 아님). 10위 점수 0.47~0.83,
결과에 나온 프로젝트 수는 query당 4~9개.

그 밖의 경우(각 5회 중앙값):

| query | 지연 | 결과 수 |
|---|---|---|
| 배열 2개 `["sqlite","daemon"]` | 48 ms | 3 |
| 배열 3개 (한글) | 81 ms | 0 |
| 배열 5개 (영어) | 126 ms | 0 |
| limit 50 (영어 / 한글) | 29 / 33 ms | 50 |
| 흔한 토큰 `the` / `error` | 33 / 24 ms | 10 |
| 한 글자 `이` (prefix) | 87 ms | 10 |
| `a b c d e f g h i j` | 35 ms | 10 |

차가운 시작:

| 경우 | 값 |
|---|---|
| warm 데몬에 새 MCP 세션, 첫 query | 38~162 ms |
| 데몬 없음 → `mcp`가 데몬을 띄움 → `initialize` | 67 ms |
| 그 직후 첫 query (모델 로딩 중, keyword-only 안내 포함) | 8 ms |
| 모델 준비 (캐시 있음) | 데몬 시작 뒤 1.1 s |
| 모델 준비 직후 query | 25~33 ms |

모델이 캐시에 없을 때의 다운로드 시간(약 470 MB)은 재지 않았다.

## 3. E2E Claude Code

환경: Claude Code 2.1.288. `EPISODIC_MEMORY_DIR=/tmp/em-e2e`,
`EPISODIC_MEMORY_BIN=<worktree>/target/release/episodic-memory`, 작업 디렉터리 `/tmp/em-e2e-work`.
`/tmp/em-e2e`는 1단계 결과(아카이브, DB, 모델)를 clone하고 DB의 `archive_path`를
`/tmp/em-e2e/`로 바꿔 만들었다. 실제 소스 전체(4.5 GB)를 새로 복사하지 않기 위해서다.
설치된 3.2.0 플러그인은 실행마다 `--settings '{"enabledPlugins":{"episodic-memory@baleen-marketplace":false}}'`로 껐다.
권한 우회 플래그는 쓰지 않고 `--allowedTools`로 필요한 도구만 허용했다.

**세션 1** (`--allowedTools Write Agent Task`): 서브에이전트 1개가 `/tmp/em-e2e-work/lighthouse.txt`에
코드워드 `ZEPHYRQUOKKA7319` 문장을 쓰게 했다.

- init: `plugin:episodic-memory:episodic-memory` connected
- SessionStart hook 전부 exit 0. hook의 `sync`가 데몬을 띄웠다(`daemon-3.2.0.lock` 생성).
- 도구 호출: Agent → (서브에이전트) Write. 파일 내용 확인됨.
- transcript: 본 세션 `.jsonl` + `subagents/agent-*.jsonl`

**세션 2** (`--allowedTools mcp__plugin_episodic-memory_episodic-memory__search mcp__plugin_episodic-memory_episodic-memory__read`):
SessionStart hook이 sync를 요청했고, 모델이 `search` → `read`를 직접 호출했다.

`search {"query": "ZEPHYRQUOKKA7319 lighthouse inventory"}` 결과 카드 (상위 2개, 3위 이후는 실데이터라 생략):

```text
1. [em-e2e-work, 2026-10-03, score 1.00]
   User: We are setting up a lighthouse inventory note. Use the Agent tool exactly once to dispatch a general-purpose subagent that writes the file /tmp/em-e2e-work/lighthouse.txt with exactly this content: 'C
   Assistant: `/tmp/em-e2e-work/lighthouse.txt`에 코드워드 ZEPHYRQUOKKA7319와 황동 랜턴 42개 내용이 정확히 기록된 것을 확인했습니다.
   /tmp/em-e2e/conversation-archive/claude-code-projects/-private-tmp-em-e2e-work/229a1fad-69b3-47f2-8dc0-f3d059ae9c8a.jsonl:5-39

2. [em-e2e-work, 2026-10-03, score 0.89]
   User: Write the file /tmp/em-e2e-work/lighthouse.txt with exactly this content (no trailing extras beyond what's shown): Codeword ZEPHYRQUOKKA7319: the lighthouse inventory has 42 brass lanterns and 7 fog
   Assistant: 
   /tmp/em-e2e/conversation-archive/claude-code-projects/-private-tmp-em-e2e-work/229a1fad-69b3-47f2-8dc0-f3d059ae9c8a/subagents/agent-a38e314ab5bfd7685.jsonl:1-34
```

2위는 서브에이전트(sidechain) exchange다. 0.9 감점이 적용되어 본 세션 아래에 놓였다.

`read {path: <1위 경로>, startLine: 5, endLine: 39}` 출력 일부:

```text
L5 **User:** We are setting up a lighthouse inventory note. Use the Agent tool exactly once to dispatch a general-purpose subagent that writes the file /tmp/em-e2e-work/lighthouse.txt with exactly this content: 'Codeword ZEPHYRQUOKKA7319: the lighthouse inventory has 42 brass lanterns and 7 fog horns.' ...

L23 **Tool Agent:** {"description":"Write lighthouse inventory file","prompt":"Write the file /tmp/em-e2e-work/lighthouse.txt with exactly this content ...","run_in_background":false,"subagent_type":"general-purpose"}

L35 **Assistant:** `/tmp/em-e2e-work/lighthouse.txt`에 코드워드 ZEPHYRQUOKKA7319와 황동 랜턴 42개 내용이 정확히 기록된 것을 확인했습니다.
```

세션 2의 최종 답: 랜턴 42개, 파일 `/tmp/em-e2e-work/lighthouse.txt`. 통과.

## 4. E2E Codex

환경: codex-cli 0.160.0, `codex exec --json --skip-git-repo-check`.
설치된 3.2.0 플러그인은 `-c 'plugins."episodic-memory@baleen-marketplace".enabled=false'`로 껐고,
이 플러그인의 MCP 서버는 설정 덮어쓰기로 붙였다(`~/.codex/config.toml`은 건드리지 않음):

```bash
codex exec --json --skip-git-repo-check -s workspace-write -C /tmp/em-e2e-codex-work \
  -c 'plugins."episodic-memory@baleen-marketplace".enabled=false' \
  -c 'mcp_servers.episodic-memory.command="<worktree>/bin/episodic-memory"' \
  -c 'mcp_servers.episodic-memory.args=["mcp"]' \
  -c 'mcp_servers.episodic-memory.env={EPISODIC_MEMORY_DIR="/tmp/em-e2e",EPISODIC_MEMORY_BIN="<worktree>/target/release/episodic-memory"}' \
  "<prompt>"
```

**hook 대체 (수동)**: `codex exec`에서 이 플러그인의 SessionStart hook을 비대화식으로 싣는 방법이 없었다.
`-c 'hooks.SessionStart=[...]'`로 넣은 hook(마커 파일을 만드는 명령 포함)은 실행되지 않았다.
`--dangerously-bypass-hook-trust`와 `~/.codex/hooks.json` 수정은 쓰지 않았다.
그래서 세션 1과 2 사이에 hook 명령과 똑같은 명령을 직접 돌렸다:

```bash
PLUGIN_ROOT=<worktree> EPISODIC_MEMORY_DIR=/tmp/em-e2e EPISODIC_MEMORY_BIN=... \
  sh -c '"${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/bin/episodic-memory" sync'   # exit 0
```

**세션 1**: 서브에이전트(`spawn_agent`) 1개가 `/tmp/em-e2e-codex-work/buoys.txt`에
코드워드 `MARIGOLDNARWHAL4826` 문장을 썼다. rollout 2개(본 세션, 서브에이전트)가 생겼고,
수동 sync 뒤 둘 다 색인됐다(본 세션 L10-51 sidechain 0, 서브에이전트 L10-20 sidechain 1, 둘 다 임베딩됨,
project `em-e2e-codex-work`, harness `codex`).

**세션 2** (`-s read-only`): 모델이 MCP `search` → `read`를 호출했다.

`search {"query": "MARIGOLDNARWHAL4826 harbor buoy registry"}` 1위 카드 (2위 이후 실데이터 생략):

```text
1. [em-e2e-codex-work, 2026-10-03, score 1.00]
   User: We are recording a harbor buoy registry. Spawn exactly one subagent (use your sub-agent/spawn tool) and have it write the file /tmp/em-e2e-codex-work/buoys.txt with exactly this content: 'Codeword MAR
   Assistant: `<skill>` 지침에 따라 Codex 도구 사용법을 확인한 뒤, 요청하신 서브에이전트 하나만 실행하겠습니다. 코드워드 MARIGOLDNARWHAL4826을 확인했고, 빨간 부이는 13개입니다.
   /tmp/em-e2e/conversation-archive/codex-sessions/2026/10/04/rollout-2026-10-04T00-32-14-01a10264-fa85-7f42-94d1-7b9ab5f65d20.jsonl:10-51
```

`read {startLine: 10, endLine: 51}` 출력 일부 (9.3 KB 중):

```text
L29 **Tool spawn_agent:** {"task_name":"write_buoy_registry","fork_turns":"none", ... "message":"gAAAA...(암호화된 메시지)"}

L32 **Result:** {"task_name":"/root/write_buoy_registry"}

L37 **Tool wait_agent:** {"timeout_ms":300000}

L48 **Assistant:** 코드워드 MARIGOLDNARWHAL4826을 확인했고, 빨간 부이는 13개입니다.
```

세션 2의 최종 답: 빨간 부이 13개, 파일 `/tmp/em-e2e-codex-work/buoys.txt`. MCP 경로와 Codex 파싱 경로는 통과.
hook 경로는 Codex에서 자동으로 검증하지 못했다.

**사용자가 직접 할 확인 (Codex hook)**:

1. 4.0.0을 마켓플레이스에서 설치한 뒤에만 한다. `EPISODIC_MEMORY_BIN`은 설정하지 않는다
   (`echo "${EPISODIC_MEMORY_BIN:-unset}"` → `unset`).
2. README "Codex" 절차대로 hooks.json 조각을 `~/.codex/hooks.json`의 `hooks.SessionStart`에 합친다.
   경로는 실제 설치 경로로 바꾼다. 경로 확인:
   `ls -d ~/.codex/plugins/cache/baleen-marketplace/episodic-memory/4.0.0/bin/episodic-memory`
3. 기준값을 적어 둔다:
   `sqlite3 ~/.config/episodic-memory/episodic.db "select value from meta where key='sync_count'"`
4. 새 Codex 세션을 연다 (`codex`, 처음이면 hook trust를 승인). 몇 초 기다린다.
5. 3번 명령을 다시 실행한다. 기대값: 기준값 + 1.

## 5. 발견한 문제 (코드는 바꾸지 않음)

1. **드문 정확 키워드만으로는 순위가 낮다.** `search "MARIGOLDNARWHAL4826"`(그 exchange에만 있는 토큰)은
   limit 50에서 29위였다. BM25 1위 단독 점수 0.4/61(≈0.0066)은 sidechain이 아닌 벡터 단독 1~31위의
   0.6/(60+r)보다 작다. 그래서 BM25에만 있으면 32위쯤이 되어야 하는데 실제는 29위였다. 벡터 상위 일부가
   sidechain(×0.9, 벡터 23위 아래면 0.0066보다 작아짐)이었거나, 이 exchange가 벡터 목록 하위에도 들어간
   것으로 보인다. 이번 측정에서는 둘을 구분하지 않았다. 어느 쪽이든 정확히 맞는 드문 토큰이 상위 10위 밖으로
   밀린다. 문장으로 물으면(벡터도 맞으면) 1위가 된다. RRF 가중치(스펙 상수) 문제라 이 작업 범위 밖으로 둔다.
2. **배열 AND query가 쉽게 0건이 된다.** 개념마다 `limit*5`(50)개만 보고 대화 단위로 교집합을 내서,
   35k exchange에서 3~5개 개념은 0건이 나왔다.
3. **Agent team의 `<teammate-message>`가 user 메시지로 색인된다** (1,422개). 일반 query 상위에 자주 나온다.
4. **Claude 서브에이전트 exchange의 Assistant 스니펫이 비어 있다.** 서브에이전트가 마지막 보고를
   텍스트가 아니라 도구 호출(`SubagentHandback`)로 넘겨서다.
5. **데몬 메모리.** 임베딩 중 RSS 4.3 GB, 끝난 뒤에도 줄지 않는다. 모델만 올린 유휴 데몬도 1.8 GB.
6. 결과 날짜는 UTC 기준이다(한국 시간 10-04 00시대 세션이 2026-10-03으로 표시).

## 6. 디스크

| 시점 | 데이터 볼륨 여유 |
|---|---|
| 시작 | 8.5 GB |
| 들여오기·임베딩 중 | 7.7~7.9 GB |
| E2E 뒤 | 7.2 GB |

아카이브와 모델은 clone이라 실제로 늘어난 것은 DB(291 MB ×2), sync가 붙인 새 바이트, 빌드 산출물 정도다.

## 7. 남은 일

1. 4.0.0 Release 뒤 스펙 §9 배포 검증: `EPISODIC_MEMORY_BIN` 없이 래퍼 실행 → 다운로드 → 체크섬 검증 → 실행.
2. 4절의 Codex hook 수동 확인 (사용자 기기에서 대화형 `codex`로).
