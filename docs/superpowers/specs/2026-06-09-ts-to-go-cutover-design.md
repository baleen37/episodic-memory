# TS → Go 대체 (cutover) 설계

- 날짜: 2026-06-09
- 브랜치: bold-beacon-carmack
- 상태: 승인 대기

## 배경 / 문제

`#42 feat: port memmem from TypeScript/Bun to Go`가 머지되어 Go 구현이 레포에
들어왔다. 그러나 현재 레포에는 **TS/Bun 구현과 Go 구현이 공존**한다:

- Go: `cmd/`, `internal/`, `go.mod`, `.goreleaser.yaml`, `.github/workflows/go-ci.yml`
- TS: `src/`(87개), `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`,
  `node_modules/`, `package-lock.json`, `dist/*.mjs`, `.github/workflows/ci.yml`

그리고 **플러그인의 실제 진입점이 전부 TS/Bun을 호출**한다:

- `.mcp.json` → `bun scripts/mcp-server-wrapper.mjs`
- `hooks/hooks.json` → `sh hooks/run.sh sync` → `hooks/run.sh`가 `bun dist/cli.mjs` 실행
- `package.json` `postinstall` → `conditional-build.sh` → `bun run build`
- `hooks/ensure-deps.sh` → `npm install` (node_modules)

즉 TS를 단순 삭제하면 **플러그인이 통째로 죽는다.** 이 작업의 본질은 단순 삭제가
아니라 **진입점을 Go 바이너리로 재배선한 뒤 TS를 제거**하는 것이다.

## 목표

1. Go가 TS와 **동작상 동등(E2E 검증)** 함을 증명한다.
2. 플러그인 진입점(hooks, MCP, postinstall)을 Go 바이너리로 재배선한다.
3. TS/Bun 잔재를 제거한다.
4. 문서(CLAUDE.md, README)를 Go 기준으로 갱신한다.

## 비목표 (YAGNI)

- 기존에 양쪽 모두 호출되지 않는 dead code(`archive.ts`, `compress.ts`,
  `normalizer.ts`)를 Go로 추가 포팅하지 않는다 — TS 전체 제거로 함께 사라진다.
- goreleaser 릴리스 파이프라인 재설계는 하지 않는다(이미 Go용으로 완성됨).
- 새 기능 추가 없음. 순수 cutover.

## 패리티 검증 결과 (사전 조사 요약)

| 영역 | 상태 |
| --- | --- |
| CLI 명령 (sync/search/read/stats/verify/doctor) | Go에 전부 구현, 플래그(--limit/--after/--before/--source-kind/--start-line/--end-line) 일치 |
| MCP 툴 (search/fetch) + 입력 스키마 | Go에 구현, 스키마 일치 |
| core 모듈 (db/indexer/search/read/embeddings/sources/lock/logger/paths/project/ratelimiter/migrations) | Go에 전부 매핑 |
| llm (config/extractor/gemini/zai/roundrobin) | Go에 전부 매핑 |
| `archive.ts` / `compress.ts` / `normalizer.ts` | 양쪽 다 dead code(호출 없음). 포팅 불필요 |

**결론: 기능 패리티는 사실상 완료.** 남은 갭은 (1) 진입점 재배선, (2) Go 빌드의
런타임 자산 스테이징, (3) 동작 E2E 미검증 뿐이다.

## 바이너리 배치 결정 (확정)

최신 공식 문서(Claude Code 2.1.169) 기준:

- 플러그인 `bin/` 디렉토리의 실행파일은 **Bash 툴의 PATH에만** 자동 추가된다.
  hooks/MCP 프로세스는 이 PATH 상속을 **보장하지 않는다.**
- hooks/MCP에서 번들 바이너리를 참조하는 정석은 **`${CLAUDE_PLUGIN_ROOT}/bin/<binary>`**
  명시 경로다.

**결정:**

- Go 바이너리를 `bin/memmem`, `bin/memmem-mcp`에 둔다(신기능 활용 — Bash 직접 호출 가능).
- hooks/MCP는 `${CLAUDE_PLUGIN_ROOT}/bin/memmem` · `${CLAUDE_PLUGIN_ROOT}/bin/memmem-mcp`로
  명시 참조한다(문서가 보장하는 안전한 방식).

> 참고: `.goreleaser.yaml`의 `binary:` 이름은 이미 `memmem` / `memmem-mcp`다.
> 로컬 개발 빌드 산출 위치를 `dist/`에서 `bin/`으로 맞춘다(아래 Phase A).

## 단계별 설계

Phase 사이 전이마다 검증을 통과해야 다음으로 넘어간다. Phase A·B는 **아무것도 제거하지
않는다** — 검증이 깨지면 멈추고 보고한다. 제거는 Phase C에서만, 검증 통과 후에 한다.

### Phase A — 빌드 & 단위테스트 (제거 없음)

1. `scripts/stage-runtime-assets.sh` 실행 → `internal/core/runtime/embedded/`에
   플랫폼별 ORT dylib/so + 토크나이저 스테이징.
   - **verify:** `go build ./...` 통과 (현재는 `embedded/libonnxruntime.dylib`
     없어서 실패).
2. Go 바이너리를 `bin/`에 빌드: `go build -o bin/memmem ./cmd/memmem`,
   `go build -o bin/memmem-mcp ./cmd/memmem-mcp`.
   - **verify:** 두 바이너리 생성, `bin/memmem --help` 정상 출력.
3. `go test ./...` 전체 실행 (CGO 필요한 e2e 포함).
   - **verify:** 전부 PASS.

### Phase B — 동작 E2E 검증 (제거 없음)

4. CLI 동작 검증: `bin/memmem` 으로 sync → search → read → stats → verify → doctor
   를 실제 실행. 가능하면 기존 TS(`bun dist/cli.mjs <cmd>`)와 동일 입력으로 출력 비교.
   - 참고: `scripts/phase6/`에 TS↔Go equivalence 도구(`run_equivalence.sh` 등)가 이미 있다. 활용한다.
   - **verify:** 비정상 종료 없음, 핵심 명령 출력이 TS와 동등.
5. MCP 서버 동작 검증: `bin/memmem-mcp` 를 직접 구동하여 `initialize` →
   `tools/list` → `search` / `read` 툴 호출을 JSON-RPC로 확인.
   - **verify:** 툴 목록·입력 스키마·응답이 TS MCP와 동등.

### Phase C — 재배선 · 제거 · 문서 (커밋 단위 분리)

6. **재배선** (제거 전에 먼저):
   - `.mcp.json`: `bun scripts/mcp-server-wrapper.mjs` →
     `${CLAUDE_PLUGIN_ROOT}/bin/memmem-mcp`.
   - `hooks/hooks.json`: `sh hooks/run.sh sync` →
     `"${CLAUDE_PLUGIN_ROOT}"/bin/memmem` + args `["sync"]` (exec form 권장).
     Stop 훅도 동일.
   - `package.json` `postinstall`(`conditional-build.sh`): bun 빌드 → `go build`로
     `bin/memmem`·`bin/memmem-mcp` 생성. (또는 postinstall 자체를 Go 빌드 스크립트로 교체)
   - **verify:** 재배선 후 hooks/MCP가 죽은 경로를 가리키지 않음. 가능하면
     `.mcp.json` 경로로 MCP 재구동해 search/read 정상.

7. **TS/Bun 잔재 제거**:
   - 소스/설정: `src/`, `package.json`, `package-lock.json`, `bun.lock`,
     `bunfig.toml`, `tsconfig.json`, `node_modules/`.
   - bun/node 산출물: `dist/cli.mjs`, `dist/cli-internal.mjs`, `dist/mcp-server.mjs`,
     `dist/mcp-wrapper.mjs`, `dist/lib/` 등 TS 번들.
   - bun/node 기반 스크립트: `scripts/build.mjs`, `scripts/mcp-server-wrapper.mjs`,
     `scripts/conditional-build.sh`(Go 빌드로 대체되었으면 제거),
     `scripts/start-mcp-server.sh`, `scripts/resolve-plugin-root.sh`,
     `scripts/preload-sqlite.ts`, `hooks/run.sh`, `hooks/ensure-deps.sh`,
     `hooks/hooks.test.ts`, `test-all.sh`(vitest).
   - `scripts/phase6/`: equivalence 검증 도구. Phase B에서 다 쓴 뒤 제거.
   - **개별 확인 필요(추측 금지):** `.github/workflows/ci.yml`(TS CI — 제거 후보),
     `.github/workflows/on-release.yml`(TS 마켓플레이스 릴리스 — 제거/대체 검토),
     `release.yml`·`go-ci.yml`·`update-versions.yml` 내 `bun` 참조는 staging 등
     다른 용도일 수 있으니 줄 단위로 확인 후 정리.
   - **verify:** `go build ./...` / `go test ./...` 여전히 통과. 레포에 bun/npm
     없이도 빌드 가능. grep으로 남은 `bun`/`node_modules`/`dist/*.mjs` 참조 0건
     (단, 의도적으로 남긴 것 제외).

8. **문서 갱신**:
   - `CLAUDE.md`: Commands 섹션(`bun test` → `go test ./...` 등), Key Files 표,
     Build Output 섹션을 Go 기준으로. "CRITICAL: Always use bun" 류 지침 정정.
   - `README.md`: 설치/사용법의 bun/npm → Go 바이너리(`bin/`) 기준.
   - **verify:** 문서 내 bun/ts 명령이 Go 기준으로 정정됨. 남은 `bun run`/`bun test`
     지침 0건.

## 검증 전략 (요약)

- 각 Phase 전이는 명시된 verify를 통과해야 다음으로 진행.
- "제거"는 검증 통과 후에만. Phase A/B에서 깨지면 제거 없이 보고.
- 최종: bun/npm 없는 환경에서 `go build`·`go test` 통과 + 플러그인 진입점이 Go
  바이너리를 정상 호출.

## 리스크 / 주의

- **CGO 크로스컴파일 불가**: 로컬 빌드는 네이티브 플랫폼만. 멀티플랫폼 배포는 기존
  goreleaser 매트릭스 워크플로가 담당(이 작업 범위 밖).
- **런타임 자산 스테이징 누락 시 빌드 실패**: Phase A-1이 전제. CI에서도 동일.
- **워크플로 제거 시 릴리스 파이프라인 손상 위험**: `ci.yml`/`on-release.yml`은
  줄 단위 확인 후 제거. 불확실하면 남기고 보고.
- **bin/ 산출물 git 추적 여부**: 바이너리(~88MB)를 커밋하지 않는다. `bin/`은
  `.gitignore`에 추가하고, 설치 시 postinstall이 빌드하도록 한다(현 구조와 동일 철학).
