# Design: `bin/` 단일 진입점 통일

작성일: 2026-06-10

## 배경

memmem 플러그인은 현재 세 갈래 진입점이 제각각 다른 경로로 CLI/MCP를 호출한다.
이 구조는 `CLAUDE_PLUGIN_ROOT`가 로컬 설치에서 안 잡히던 버그
([anthropics/claude-code#9354](https://github.com/anthropics/claude-code/issues/9354))를
우회하기 위해 만들어진 것이다.

### 현재 진입점 (Before)

| 진입점 | 경로 |
| ------ | ---- |
| CLI | `package.json` bin → `dist/cli.mjs` |
| hook | `hooks/hooks.json` → `${CLAUDE_PLUGIN_ROOT}/hooks/run.sh` → `scripts/resolve-plugin-root.sh` → `bun dist/cli.mjs` |
| MCP | `.mcp.json` → `bun scripts/mcp-server-wrapper.mjs` (cwd 상대경로) |

우회 로직은 `scripts/resolve-plugin-root.sh`(약 60줄, python으로 `installed_plugins.json` 조회)와
`hooks/run.sh`, `scripts/start-mcp-server.sh`에 분산돼 있다.

## 검증된 전제 (실측 완료)

Claude Code 2.1.170 환경에서 실측으로 확인했다.

| 전제 | 결과 | 근거 |
| ---- | ---- | ---- |
| hook subprocess에 `CLAUDE_PLUGIN_ROOT` 채워짐 | ✅ | 프로브 로그 실측: `/Users/.../baleen-marketplace/memmem/1.5.0` |
| `bin/` 디렉터리가 Bash 도구 PATH에 자동 등록됨 | ✅ | `$PATH`에 `.../memmem/1.5.0/bin` 존재 확인 |
| `.mcp.json` command에서 `${CLAUDE_PLUGIN_ROOT}` 치환됨 | ✅ | 공식 문서(plugins-reference): "substituted in ... server configs" |

→ issue #9354는 이 버전에서 해결됨. 우회 로직 전면 제거 가능.

주의: `bin/` PATH 자동등록은 **Bash 도구 한정**이다. MCP 서버는 별도 subprocess로
기동되므로 PATH에 의존하지 않고 `${CLAUDE_PLUGIN_ROOT}/bin/memmem` 절대경로로 가리킨다.

## 목표

세 진입점을 `bin/memmem` 단일 실행 shim으로 통일하고, 우회 로직을 제거한다.

## 설계 (After)

`bin/memmem`을 **간접 호출 shim이 아니라 실행 본체(graceful wrapper)** 자체로 만든다.
빌드 출력 위치가 `dist/cli.mjs` → `bin/memmem`으로 바뀐다. (결정: B-1)

### `bin/memmem` = graceful wrapper (실행파일)

현재 `dist/cli.mjs`(= `src/cli-graceful.mjs` 복사본)가 하던 역할을 `bin/memmem`이 그대로 맡는다.

- shebang `#!/usr/bin/env bun`로 직접 실행 가능 (Bash PATH 자동 등록 → bare `memmem` 호출).
- 첫 실행 시 의존성 체크 → 없으면 백그라운드 설치 → 번들 본체 import (안전장치 유지).
- 번들 본체 `cli-internal.mjs`는 `bin/memmem`이 import할 수 있는 위치에 둔다 (구현 시 `bin/cli-internal.mjs` vs `dist/cli-internal.mjs` 경로 확정).

`CLAUDE_PLUGIN_ROOT`는 graceful wrapper 안에서 `import.meta.url` 기준 상대경로로 본체를 찾으므로
별도 해석이 불필요하다. hook/MCP 진입점이 `${CLAUDE_PLUGIN_ROOT}/bin/memmem`로 절대경로 호출한다.

### 진입점별 변경

| 진입점 | After |
| ------ | ----- |
| CLI | `bin/memmem` (PATH 자동 등록 → bare `memmem` 호출 가능, 간접 없음) |
| hook | `hooks/hooks.json` → `${CLAUDE_PLUGIN_ROOT}/bin/memmem sync` |
| MCP | `.mcp.json` → `"command": "${CLAUDE_PLUGIN_ROOT}/bin/memmem", "args": ["mcp"]` |

### 신규: `memmem mcp` 서브커맨드

현재 MCP는 `scripts/mcp-server-wrapper.mjs`로 별도 진입한다. 이 wrapper가 담당하던
"node_modules 없으면 설치 → 빌드 필요하면 빌드 → `bun mcp-server.mjs` spawn" 부트스트랩을
CLI 라우터(`src/cli/main.ts`)의 `mcp` 서브커맨드로 흡수한다. `bin/memmem mcp`가 MCP 서버를 기동한다.

### 삭제 대상

- `scripts/resolve-plugin-root.sh` — 우회 로직 (불필요)
- `hooks/run.sh` — `bin/memmem`이 대체
- `scripts/start-mcp-server.sh` — 미사용 + 우회
- `scripts/mcp-server-wrapper.mjs` — `mcp` 서브커맨드로 흡수
- `src/cli-graceful.mjs` → `bin/memmem`으로 이동/대체 (별도 dist 복사 불필요)

### 유지

- 번들 본체(`cli-internal`, `mcp-server`) — `bin/memmem`이 호출하는 실행 본체
- `scripts/lib/check-dependencies.mjs` — graceful 체크 로직
- `package.json`의 `bin` 필드 — npm 설치 호환성 (Claude Code plugin bin과 별개 규약). `dist/cli.mjs` → `bin/memmem`으로 경로 갱신.

## 빌드 출력 변경

`scripts/build.mjs`:
- `dist/cli.mjs`(graceful 복사) → `bin/memmem`(shebang 실행파일, `chmod +x`)로 출력.
- `dist/cli-internal.mjs`(번들 본체) → `bin/memmem`이 import하는 위치로 출력.
- `mcp-server` 번들은 `mcp` 서브커맨드가 spawn하는 위치에 유지.
- `bin/`이 빌드 산출물이 되므로 `.gitignore` / `conditional-build.sh` 동작 확인.

## 테스트 / 검증

- `hooks/hooks.test.ts` — hook command 문자열이 새 경로(`${CLAUDE_PLUGIN_ROOT}/bin/memmem sync`)와 일치하도록 갱신.
- 빌드 후 설치본에서 실제 hook 트리거 → sync 동작 확인.
- `.mcp.json` 변경 후 MCP 서버 기동 확인 (`bin/memmem mcp`).
- bare `memmem doctor` 호출이 Bash 도구에서 동작하는지 확인.
- 첫 실행(node_modules 없는 상태) graceful 자동설치 안전장치 회귀 확인.

## 영향 범위

`grep`로 확인된 참조 파일:
- `hooks/run.sh`, `hooks/hooks.json`, `hooks/hooks.test.ts`, `hooks/ensure-deps.sh`
- `scripts/mcp-server-wrapper.mjs`, `scripts/start-mcp-server.sh`, `scripts/resolve-plugin-root.sh`
- `scripts/lib/check-dependencies.mjs`
- `.mcp.json`, `package.json`
