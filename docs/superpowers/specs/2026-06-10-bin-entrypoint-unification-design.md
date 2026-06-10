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

### `bin/memmem` (단일 shim)

```sh
#!/bin/sh
# Plugin executable — auto-added to the Bash tool PATH while the plugin is enabled.
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
exec bun "$ROOT/dist/cli.mjs" "$@"
```

- `CLAUDE_PLUGIN_ROOT` 우선, 없으면 스크립트 위치 기준 fallback (한 줄).
- `resolve-plugin-root.sh`의 60줄 python 로직을 대체한다.

### 진입점별 변경

| 진입점 | After |
| ------ | ----- |
| CLI | `bin/memmem` (PATH 자동 등록 → bare `memmem` 호출 가능) |
| hook | `hooks/hooks.json` → `${CLAUDE_PLUGIN_ROOT}/bin/memmem sync` |
| MCP | `.mcp.json` → `"command": "${CLAUDE_PLUGIN_ROOT}/bin/memmem", "args": ["mcp"]` |

### 신규: `memmem mcp` 서브커맨드

현재 MCP는 `scripts/mcp-server-wrapper.mjs`로 별도 진입한다. 이를 CLI 라우터(`src/cli/main.ts`)에
`mcp` 서브커맨드로 흡수해 `bin/memmem mcp`가 MCP 서버를 기동하도록 한다.

`mcp-server-wrapper.mjs`가 담당하던 "node_modules 없으면 설치, dist 없으면 빌드"
부트스트랩 로직의 처리 위치는 구현 단계에서 결정한다 (서브커맨드 진입 시점 흡수 vs 유지).

### 삭제 대상

- `scripts/resolve-plugin-root.sh` — 우회 로직 (shim 한 줄로 대체)
- `hooks/run.sh` — shim이 대체
- `scripts/start-mcp-server.sh` — 미사용 + 우회

### 유지

- `dist/` bun 번들 — shim이 호출하는 실행 본체
- `package.json`의 `bin` 필드 — npm 설치 호환성 (Claude Code plugin bin과 별개 규약)

## 테스트 / 검증

- `hooks/hooks.test.ts` — hook command 문자열이 새 경로(`${CLAUDE_PLUGIN_ROOT}/bin/memmem sync`)와 일치하도록 갱신.
- 빌드 후 설치본에서 실제 hook 트리거 → sync 동작 확인.
- `.mcp.json` 변경 후 MCP 서버 기동 확인.
- bare `memmem doctor` 호출이 Bash 도구에서 동작하는지 확인.

## 영향 범위

`grep`로 확인된 참조 파일:
- `hooks/run.sh`, `hooks/hooks.json`, `hooks/hooks.test.ts`, `hooks/ensure-deps.sh`
- `scripts/mcp-server-wrapper.mjs`, `scripts/start-mcp-server.sh`, `scripts/resolve-plugin-root.sh`
- `scripts/lib/check-dependencies.mjs`
- `.mcp.json`, `package.json`
