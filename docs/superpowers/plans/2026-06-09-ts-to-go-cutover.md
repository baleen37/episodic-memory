# TS → Go Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Go 구현이 TS와 동작상 동등함을 검증한 뒤, 플러그인 진입점을 Go 바이너리로 재배선하고 TS/Bun 잔재를 제거한다.

**Architecture:** 검증 게이트(Phase A 빌드+단위테스트, Phase B 동작 E2E) → 변경(Phase C 재배선→제거→문서). Phase A·B는 아무것도 제거하지 않으며, 검증이 깨지면 멈추고 보고한다. Go 바이너리는 `bin/`에 두고 hooks/MCP는 `${CLAUDE_PLUGIN_ROOT}/bin/<binary>`로 명시 참조한다.

**Tech Stack:** Go 1.26 (CGO, onnxruntime_go + daulet/tokenizers), sqlite-vec, MCP go-sdk. 호스트는 darwin/arm64.

---

## 검증 작업의 특수성

이 plan은 일반적인 "테스트 작성 → 구현" TDD와 다르다. Phase A·B는 **이미 존재하는 Go 코드가 동작하는지 검증하는 게이트**다. 각 게이트는 명령 실행 + 기대 출력 확인으로 검증한다. Phase C부터 실제 파일 변경이 일어난다.

각 게이트 작업에서 **검증이 실패하면**: 멈추고, 실패 출력을 그대로 보고하고, BLOCKED 상태로 에스컬레이션한다. 검증 실패를 우회하거나 가정으로 진행하지 않는다.

---

## File Structure

| 파일 | 변경 종류 | 책임 |
| --- | --- | --- |
| `internal/core/runtime/embedded/` | 스테이징(빌드 산출) | 플랫폼별 ORT dylib + tokenizer.json (go:embed 대상) |
| `bin/memmem`, `bin/memmem-mcp` | 생성(빌드 산출) | Go CLI / MCP 바이너리 |
| `.gitignore` | 수정 | `bin/` 바이너리 추적 제외 |
| `.mcp.json` | 수정 | MCP 서버를 Go 바이너리로 |
| `hooks/hooks.json` | 수정 | SessionStart/Stop 훅을 Go 바이너리로 |
| `package.json` | 삭제 | TS 패키지 매니페스트 |
| `scripts/build-binaries.sh` | 생성 | Go 바이너리 빌드(postinstall 대체) |
| `src/`, `dist/*.mjs`, bun/node 스크립트·훅 | 삭제 | TS 잔재 |
| `CLAUDE.md`, `README.md` | 수정 | Go 기준 문서화 |

---

## Phase A — 빌드 & 단위테스트 (제거 없음)

### Task 1: 런타임 자산 스테이징 + Go 빌드 검증

**Files:**
- 산출: `internal/core/runtime/embedded/libonnxruntime.dylib`, `internal/core/runtime/embedded/tokenizer.json`

- [ ] **Step 1: 자산 스테이징 스크립트 실행**

Run: `bash scripts/stage-runtime-assets.sh`
Expected: `Staged embed assets into .../internal/core/runtime/embedded (GOOS=darwin):` 출력. darwin 호스트는 in-repo fallback dylib을 쓰므로 `MEMMEM_ORT_LIB_SRC` 불필요.

만약 "missing ORT lib source" 또는 "missing tokenizer source"로 실패하면: BLOCKED로 보고(자산 소스가 레포에 없음 — `poc/packaging/README.md`의 Reproduce 절차 필요).

- [ ] **Step 2: 전체 빌드 검증**

Run: `go build ./...`
Expected: 출력 없음, exit 0. 이전에 나던 `pattern embedded/libonnxruntime.dylib: no matching files found` 에러가 사라져야 한다.

- [ ] **Step 3: 커밋 (스테이징 자산은 커밋하지 않음 — 빌드 산출물)**

`embedded/` 자산은 빌드 산출물이므로 커밋하지 않는다. 이 Task는 코드 변경이 없으므로 커밋할 것이 없다. 다음 Task로 진행.

> 참고: `internal/core/runtime/embedded/.gitkeep`만 추적되고 실제 자산은 `.gitignore`로 제외되어 있는지 확인. 제외돼 있지 않고 자산이 추적 대상이면 BLOCKED로 보고(스테이징 자산 커밋 정책 확인 필요).

### Task 2: Go 바이너리 빌드

**Files:**
- 생성: `bin/memmem`, `bin/memmem-mcp`

- [ ] **Step 1: CLI 바이너리 빌드**

Run: `go build -o bin/memmem ./cmd/memmem`
Expected: exit 0, `bin/memmem` 생성.

- [ ] **Step 2: MCP 바이너리 빌드**

Run: `go build -o bin/memmem-mcp ./cmd/memmem-mcp`
Expected: exit 0, `bin/memmem-mcp` 생성.

- [ ] **Step 3: CLI 헬프 동작 확인**

Run: `./bin/memmem --help`
Expected: 사용법 텍스트 출력(sync/search/read/stats/verify/doctor 명령 포함), exit 0.

- [ ] **Step 4: 커밋할 코드 없음**

바이너리는 산출물이라 커밋하지 않는다(Task 6에서 `.gitignore` 처리). 다음 Task로 진행.

### Task 3: Go 전체 테스트 실행

- [ ] **Step 1: 전체 테스트 실행**

Run: `go test ./...`
Expected: 모든 패키지 `ok` 또는 `no test files`. CGO 필요한 e2e 테스트(`internal/core/indexer/e2e_cgo_test.go` 등) 포함 전부 PASS.

실패 시: 실패한 패키지/테스트 이름과 출력을 그대로 보고하고 BLOCKED. (Go 코드 자체의 버그라면 cutover 전제가 깨진 것이므로 에스컬레이션.)

- [ ] **Step 2: 커밋할 코드 없음**

검증만 수행. 다음 Phase로 진행.

---

## Phase B — 동작 E2E 검증 (제거 없음)

### Task 4: CLI 동작 E2E 검증

**Files:** 없음(검증만)

- [ ] **Step 1: sync 실행**

Run: `./bin/memmem sync`
Expected: exit 0. (LLM 미설정 시 extraction은 건너뛰지만 아카이브 sync는 동작.) 비정상 종료(panic, non-zero exit)가 없어야 한다.

- [ ] **Step 2: search 실행**

Run: `./bin/memmem search "test" --limit 3`
Expected: exit 0. 검색 결과(0건이어도 무방) 정상 출력 포맷(`## [kind, source, date] project` 형태).

- [ ] **Step 3: stats / verify / doctor 실행**

Run: `./bin/memmem stats; ./bin/memmem verify; ./bin/memmem doctor`
Expected: 각 명령 정상 실행(verify/doctor는 이슈 있으면 exit 1 가능 — 그 자체는 정상 동작). panic 없어야 한다.

- [ ] **Step 4: TS와 동등성 비교 (가능 시)**

`scripts/phase6/`에 TS↔Go equivalence 도구가 있다. 확인:
Run: `ls scripts/phase6/ && cat scripts/phase6/run_equivalence.sh`
도구가 실행 가능하고 환경이 맞으면 실행해 search 결과 동등성을 확인. 환경 의존(TS 빌드 필요 등)으로 실행 불가하면, Step 1-3의 Go 단독 동작 확인으로 충분하다고 판단하고 그 사실을 기록.

- [ ] **Step 5: 커밋할 코드 없음**

검증만. 다음 Task로.

### Task 5: MCP 서버 동작 E2E 검증

**Files:** 없음(검증만)

- [ ] **Step 1: MCP 서버에 JSON-RPC initialize + tools/list 전송**

MCP 서버는 stdio JSON-RPC다. 다음으로 initialize → tools/list를 보낸다:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | ./bin/memmem-mcp 2>/dev/null
```

Expected: `initialize` 응답 + `tools/list` 응답에 `search`, `read`(또는 `fetch`) 툴과 입력 스키마가 포함. 응답이 안 오거나 깨지면 BLOCKED 보고.

- [ ] **Step 2: search 툴 호출**

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"test","limit":2}}}' \
  | ./bin/memmem-mcp 2>/dev/null
```

Expected: id=3 응답에 검색 결과(content)가 반환(0건이어도 에러 아님). `isError:true`가 아니어야 한다.

- [ ] **Step 3: 커밋할 코드 없음**

검증만. Phase B 완료 → Phase C로.

---

## Phase C — 재배선 · 제거 · 문서

### Task 6: bin/ gitignore + 빌드 스크립트

**Files:**
- Modify: `.gitignore`
- Create: `scripts/build-binaries.sh`

- [ ] **Step 1: `.gitignore`에 bin 바이너리 제외 추가**

`.gitignore` 끝에 다음을 추가(이미 있으면 생략):

```
# Go binaries (built on install via scripts/build-binaries.sh)
/bin/memmem
/bin/memmem-mcp
```

- [ ] **Step 2: 빌드 스크립트 작성**

Create `scripts/build-binaries.sh`:

```bash
#!/usr/bin/env bash
# Build the Go binaries into bin/. Stages per-platform go:embed runtime assets
# first (ORT lib + tokenizer), then builds the CLI and MCP server.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bash scripts/stage-runtime-assets.sh
go build -o bin/memmem ./cmd/memmem
go build -o bin/memmem-mcp ./cmd/memmem-mcp

echo "Built bin/memmem and bin/memmem-mcp"
```

- [ ] **Step 3: 실행 권한 + 동작 확인**

Run: `chmod +x scripts/build-binaries.sh && bash scripts/build-binaries.sh`
Expected: `Built bin/memmem and bin/memmem-mcp` 출력, exit 0.

- [ ] **Step 4: 커밋**

```bash
git add .gitignore scripts/build-binaries.sh
git commit -m "build: add Go binary build script, gitignore bin/ binaries"
```

### Task 7: 진입점 재배선 (.mcp.json, hooks)

**Files:**
- Modify: `.mcp.json`
- Modify: `hooks/hooks.json`

- [ ] **Step 1: `.mcp.json`을 Go MCP 바이너리로 교체**

`.mcp.json` 전체를 다음으로 교체:

```json
{
  "mcpServers": {
    "memmem": {
      "command": "${CLAUDE_PLUGIN_ROOT}/bin/memmem-mcp"
    }
  }
}
```

- [ ] **Step 2: `hooks/hooks.json`을 Go CLI 바이너리로 교체**

`run.sh` 래퍼 대신 바이너리를 직접 호출(exec form, args 분리):

```json
{
  "$schema": "../../schemas/hooks-schema.json",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}\"/bin/memmem",
            "args": ["sync"]
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}\"/bin/memmem",
            "args": ["sync"]
          }
        ]
      }
    ]
  }
}
```

> 주의: `args` 필드를 hooks 스키마가 지원하는지 확인. 지원 안 하면 shell-form 단일 문자열 `"\"${CLAUDE_PLUGIN_ROOT}\"/bin/memmem sync"`로 작성. `schemas/hooks-schema.json`을 읽어 결정한다.

- [ ] **Step 3: JSON 유효성 확인**

Run: `cat .mcp.json | python3 -m json.tool >/dev/null && cat hooks/hooks.json | python3 -m json.tool >/dev/null && echo OK`
Expected: `OK`.

- [ ] **Step 4: 커밋**

```bash
git add .mcp.json hooks/hooks.json
git commit -m "feat: rewire plugin hooks and MCP to Go binaries"
```

### Task 8: TS 빌드 스크립트 제거

**Files:**
- Delete: `scripts/conditional-build.sh`, `scripts/build.mjs`

> `package.json`(postinstall 정의 포함)은 Task 9에서 통째로 삭제되므로 여기서 따로 수정하지 않는다. 빌드 스크립트만 먼저 제거해 Go 빌드 경로와의 독립성을 확인한다.

- [ ] **Step 1: TS 빌드 스크립트 제거**

```bash
git rm scripts/conditional-build.sh scripts/build.mjs
```

- [ ] **Step 2: 빌드 검증 (Go 경로 무손상 확인)**

Run: `go build ./... && echo OK`
Expected: `OK`. (Go 빌드는 이 스크립트들과 무관.)

- [ ] **Step 3: 커밋**

```bash
git add -A
git commit -m "chore: remove TS build scripts (conditional-build, build.mjs)"
```

### Task 9: TS 소스/설정/잔재 제거

**Files:**
- Delete: `src/`, `package.json`, `package-lock.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `node_modules/`, `dist/cli.mjs`, `dist/cli-internal.mjs`, `dist/mcp-server.mjs`, `dist/mcp-wrapper.mjs`, `dist/lib/`, `scripts/mcp-server-wrapper.mjs`, `scripts/start-mcp-server.sh`, `scripts/resolve-plugin-root.sh`, `scripts/preload-sqlite.ts`, `hooks/run.sh`, `hooks/ensure-deps.sh`, `hooks/hooks.test.ts`, `test-all.sh`, `scripts/phase6/`

- [ ] **Step 1: TS 소스 및 설정 제거**

```bash
git rm -r src
git rm package.json package-lock.json bun.lock bunfig.toml tsconfig.json
```

- [ ] **Step 2: node_modules 제거 (추적 중이면 git rm, 아니면 rm)**

```bash
git rm -r --cached node_modules 2>/dev/null || true
rm -rf node_modules
```

`.gitignore`에 `node_modules`가 이미 있는지 확인하고 없으면 추가.

- [ ] **Step 3: bun/node 산출물 및 스크립트 제거**

```bash
git rm dist/cli.mjs dist/cli-internal.mjs dist/mcp-server.mjs dist/mcp-wrapper.mjs
git rm -r dist/lib 2>/dev/null || true
git rm scripts/mcp-server-wrapper.mjs scripts/start-mcp-server.sh scripts/resolve-plugin-root.sh scripts/preload-sqlite.ts
git rm hooks/run.sh hooks/ensure-deps.sh hooks/hooks.test.ts
git rm test-all.sh
git rm -r scripts/phase6
```

> 위 경로 중 일부가 이미 없거나 추적 대상이 아니면 해당 `git rm`만 건너뛴다(에러 무시). 실제 존재 여부를 `ls`로 먼저 확인 후 존재하는 것만 제거.

- [ ] **Step 4: Go 빌드/테스트 무손상 확인**

Run: `go build ./... && go test ./... && echo OK`
Expected: 빌드 통과, 테스트 전부 PASS, `OK`. TS 제거가 Go에 영향 없음을 확인.

- [ ] **Step 5: 죽은 참조 스캔**

Run: `grep -rn "dist/cli.mjs\|mcp-server-wrapper\|run.sh\|bun run\|bun dist" --include="*.json" --include="*.sh" --include="*.md" . | grep -v node_modules | grep -v docs/superpowers`
Expected: 결과 0건(또는 의도적으로 남긴 것만). 남은 죽은 참조가 있으면 해당 파일을 고친다.

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "chore: remove TypeScript/Bun implementation and wrappers"
```

### Task 10: CI 워크플로 정리 (개별 확인)

**Files:**
- 검토/삭제: `.github/workflows/ci.yml`, `.github/workflows/on-release.yml`
- 검토: `.github/workflows/release.yml`, `go-ci.yml`, `update-versions.yml`

- [ ] **Step 1: TS 워크플로 식별**

Run: `head -20 .github/workflows/ci.yml; echo "---"; head -20 .github/workflows/on-release.yml`
`ci.yml`이 순수 TS CI(bun/vitest)이고 `go-ci.yml`로 대체됐으면 삭제 대상. `on-release.yml`이 TS 마켓플레이스 릴리스면 삭제/대체 검토.

- [ ] **Step 2: bun 참조 줄 단위 확인**

Run: `grep -n "bun\|npm\|vitest\|node_modules" .github/workflows/release.yml .github/workflows/go-ci.yml .github/workflows/update-versions.yml`
각 참조가 staging 등 정당한 용도인지 TS 잔재인지 판단. **불확실하면 남기고 보고**(릴리스 파이프라인 손상 방지).

- [ ] **Step 3: 확실한 TS 전용 워크플로만 제거**

`ci.yml`이 확실히 TS 전용이면:
```bash
git rm .github/workflows/ci.yml
```
`on-release.yml`은 Go 릴리스 경로와 충돌/중복인지 확인 후 판단. 불확실하면 남긴다.

- [ ] **Step 4: 커밋**

```bash
git add -A
git commit -m "ci: remove TypeScript CI workflow (superseded by go-ci)"
```

### Task 11: 문서 갱신 (CLAUDE.md, README.md)

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: CLAUDE.md Commands 섹션 갱신**

`## Commands` 섹션의 bun 명령을 Go로 교체:

```bash
go test ./...                   # Run all tests
go test ./internal/core/search  # Run single package
go build ./...                  # Build all packages
bash scripts/build-binaries.sh  # Build bin/memmem and bin/memmem-mcp
./bin/memmem <sync|search|read|stats|verify|doctor>
```

"**CRITICAL**: Always use `bun`..." 지침을 제거하고, Go/CGO 빌드 주의(런타임 자산 스테이징 필요)로 교체.

- [ ] **Step 2: CLAUDE.md Key Files / Build Output 갱신**

Key Files 표의 `src/...` 경로를 `internal/...`·`cmd/...` Go 경로로 교체. Build Output 섹션의 Bun.build/`dist/*.mjs` 설명을 `go build` → `bin/memmem`·`bin/memmem-mcp`로 교체. `bun:sqlite`/`bun test` 언급 정정.

- [ ] **Step 3: README.md 갱신**

설치/사용법의 bun/npm 명령을 Go 바이너리(`bin/`) 기준으로 교체.

- [ ] **Step 4: 죽은 명령 스캔**

Run: `grep -n "bun run\|bun test\|bun:sqlite\|dist/cli.mjs" CLAUDE.md README.md`
Expected: 0건(또는 역사적 맥락으로 의도한 것만).

- [ ] **Step 5: 커밋**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update CLAUDE.md and README for Go implementation"
```

---

## Self-Review 메모

- **Spec coverage:** Phase A(Task 1-3), Phase B(Task 4-5), Phase C 재배선(Task 6-8)·제거(Task 9-10)·문서(Task 11) — spec의 모든 단계가 작업으로 매핑됨.
- **검증 게이트:** Task 1·3·4·5는 검증 실패 시 BLOCKED 에스컬레이션 명시.
- **보수적 처리:** Task 10(워크플로)·Task 4 Step 4(equivalence)·Task 7 Step 2(hooks args)는 불확실 시 남기고 보고.
- **바이너리 정책:** `bin/` 산출물 비커밋(.gitignore), postinstall은 `build-binaries.sh`로 대체.
