# Extensible Runtime Plugin Compatibility 설계

날짜: 2026-06-21

## 문제

memmem은 우선 Claude Code와 Codex 양쪽에서 같은 기능을 제공해야 한다. 다만 향후 Gemini 같은 다른 agent runtime도 지원할 수 있으므로, 설계는 "Claude/Codex 전용"이 아니라 "runtime을 추가할 수 있는 compatibility layer"로 잡는다.

두 현재 런타임만 보더라도 plugin packaging, marketplace, cache, update semantics가 다르다. 이후 runtime이 추가되면 차이는 더 커질 가능성이 높다.

현재 repo에는 이미 런타임별 표면이 분리되어 있다.

- Codex: `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`
- Claude: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- 공통 runtime payload: `skills/`, `agents/`, `hooks/`, `.mcp.json`, `bin/memmem`, `dist/`

검증 결과:

- `claude plugin validate . --strict` 통과
- `bun run typecheck` 통과
- focused MCP/hook tests 통과
- 현재 런타임: Codex CLI `0.141.0`, Claude Code `2.1.185`, Bun `1.3.13`

따라서 본 작업은 깨진 상태 복구가 아니라, Claude/Codex dual-runtime 배포를 안정화하면서 이후 runtime 추가 비용을 낮추는 hardening이다.

## 리서치 근거

Codex 공식 문서는 `.codex-plugin/plugin.json`을 required entrypoint로 두고, `skills`, `mcpServers`, `apps`, `hooks`가 plugin root 기준 `./` 경로를 쓰도록 권장한다. Codex marketplace는 repo-scoped `$REPO_ROOT/.agents/plugins/marketplace.json`과 personal `~/.agents/plugins/marketplace.json`를 지원하며, 설치된 plugin은 `~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/` 아래 cache copy로 로드된다.

Claude 공식 문서는 `.claude-plugin/plugin.json`을 manifest로 두고, `skills/`, `agents/`, `hooks/`, `.mcp.json`, `bin/`을 plugin root에 두도록 한다. `claude plugin validate --strict`는 unrecognized field나 schema drift를 배포 전에 잡는 검증 표면이다. Claude marketplace는 `.claude-plugin/marketplace.json`을 사용하고, plugin version이 있으면 해당 version bump가 update 경계가 된다.

MCP TypeScript SDK 문서는 stdio transport 기반 server, 명시적 tool schema, startup error handling을 기본 패턴으로 제시한다. 이 공통분모가 Claude/Codex 양쪽 MCP client에서 가장 이식성 높은 형태다.

참고:

- https://developers.openai.com/codex/plugins/build
- https://code.claude.com/docs/en/plugins-reference
- https://code.claude.com/docs/en/plugin-marketplaces
- https://github.com/modelcontextprotocol/typescript-sdk

## 권장 접근

런타임별 manifest는 분리 유지하고, 공통 metadata와 검증을 강화한다. 구현은 Claude/Codex 두 adapter로 시작하지만, naming과 validation 구조는 N개 runtime을 전제로 둔다.

단일 manifest로 합치지 않는다. Claude와 Codex의 schema는 비슷하지만 같지 않고, marketplace/update/cache semantics도 다르다. 하나의 JSON으로 합치면 중복은 줄지만 schema 차이를 숨겨서 문제를 늦게 발견할 수 있다.

런타임별 package를 완전히 분리하지도 않는다. memmem의 핵심 기능은 같은 MCP server, 같은 CLI, 같은 skills/hooks를 공유하므로 package 분리는 복제와 release drift를 늘린다. 새 runtime이 추가될 때도 먼저 adapter와 manifest만 추가하고, 공통 payload는 재사용하는 방향을 기본값으로 둔다.

## Compatibility Contract

`package.json`을 공통 source of truth로 둔다.

- `version`
- `description`
- `repository`
- `license`
- `keywords`

런타임별 manifest는 이 값을 반영해야 한다.

- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.agents/plugins/marketplace.json`는 Codex marketplace display metadata와 local source path를 검증 대상으로 둔다. version은 Codex marketplace schema의 핵심 update 경계가 아니므로 `package.json` version을 복제하지 않는다.

Codex manifest는 install surface metadata를 풍부하게 유지한다.

- `interface.displayName`
- `interface.shortDescription`
- `interface.longDescription`
- `interface.developerName`
- `interface.category`
- `interface.capabilities`
- `interface.defaultPrompt`

Claude manifest는 Claude가 인식하는 metadata를 명확히 유지한다.

- `name`
- `version`
- `description`
- `author`
- `homepage`
- `repository`
- `license`
- `keywords`

Claude는 unrecognized fields를 경고로 허용하지만, `--strict` CI에서는 경고도 실패로 취급한다. 따라서 Claude manifest에 Codex-only `interface`를 섞지 않는다.

## Runtime Adapter Model

각 runtime은 하나의 adapter로 표현한다.

Adapter가 책임지는 것:

- runtime 이름과 supported status를 선언한다.
- manifest 파일 경로를 선언한다.
- marketplace 파일 경로를 선언한다.
- package metadata에서 어떤 필드를 반영해야 하는지 선언한다.
- schema/shape validation 명령 또는 local validator를 제공한다.
- runtime-specific smoke 명령을 제공한다.
- update/cache/restart semantics를 문서화한다.

Adapter가 책임지지 않는 것:

- MCP tool behavior 변경
- memory archive/index format 변경
- 공통 CLI entrypoint 변경
- 다른 runtime manifest에 자기 runtime 전용 field 주입

초기 adapter:

- `claude`: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `claude plugin validate . --strict`
- `codex`: `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`, local JSON shape check

향후 adapter 예시:

- `gemini`: Gemini가 plugin/extension manifest나 marketplace convention을 제공하면 그 파일 경로와 validator만 추가한다. Gemini가 MCP config만 소비하는 형태라면 runtime adapter는 `.mcp.json` compatibility와 install guide 검증만 담당한다.

이 모델의 핵심은 "새 runtime 추가"가 기존 Claude/Codex manifest를 수정하는 일이 아니라, 새 adapter entry와 해당 manifest/check만 추가하는 일이 되게 만드는 것이다.

## Runtime Boundary

MCP는 stdio-only로 유지한다.

현재 `.mcp.json`:

```json
{
  "mcpServers": {
    "memmem": {
      "command": "./bin/memmem",
      "args": ["mcp"],
      "cwd": "."
    }
  }
}
```

이 형태는 현재 두 런타임 모두에서 plugin root 기준 실행으로 이해하기 쉽다. 향후 runtime도 MCP를 지원한다면 이 stdio contract를 우선 재사용한다. MCP server는 다음 원칙을 유지한다.

- tool input은 strict JSON schema로 검증한다.
- tool output은 `content: [{ type: "text", text }]` 형태를 유지한다.
- read-only tool annotation을 유지한다.
- server startup failure는 stderr에 원인과 fix를 출력하고 non-zero exit한다.
- stdin close 시 server process가 종료되어 host crash 뒤 고아 process를 남기지 않는다.

## Hook Boundary

hook command는 plugin root를 런타임별로 안전하게 해석해야 한다.

현재 hook은 `${CLAUDE_PLUGIN_ROOT}/bin/memmem sync --background`를 사용한다. Codex 문서는 plugin hooks에 `PLUGIN_ROOT`, `PLUGIN_DATA`를 제공하고, 기존 plugin 호환성을 위해 `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`도 설정한다고 설명한다. 따라서 현재 형태는 동작 가능하지만, 장기적으로는 wrapper 안에서 root detection을 normalize하는 편이 낫다.

권장 원칙:

- hook JSON은 shell quoting이 단순한 형태를 유지한다.
- `bin/memmem`은 `CLAUDE_PLUGIN_ROOT`, `PLUGIN_ROOT`, executable location 순서로 root를 판단한다.
- writable state는 plugin root가 아니라 `~/.config/memmem` 또는 runtime-provided data dir를 사용한다.
- hook은 background sync만 수행하고, user-visible turn latency를 늘리지 않는다.

## Release And Update Boundary

runtime별 update semantics를 분리해서 문서화한다. 현재는 Claude와 Codex를 첫 adapter로 둔다.

Claude:

- `claude plugin validate . --strict`가 authoritative schema check다.
- marketplace refresh/update와 installed plugin update가 존재한다.
- version bump가 installed plugin update 경계가 된다.
- third-party/local marketplace auto-update는 기본적으로 보수적으로 다룬다.

Codex:

- `codex plugin marketplace upgrade`는 marketplace snapshot refresh다.
- installed plugin cache와 enabled state는 별도다.
- repo marketplace는 `.agents/plugins/marketplace.json`가 primary이고, Codex는 legacy-compatible `.claude-plugin/marketplace.json`도 읽을 수 있다.
- plugin 변경 후에는 marketplace target copy와 Codex restart/cache refresh가 필요할 수 있다.

이 차이를 README나 release checklist에 명시해야 한다. "plugin update"라는 하나의 문구로 양쪽을 설명하지 않는다.

Future runtime:

- runtime이 공식 update mechanism을 제공하면 adapter 문서에 명령과 cache 위치를 기록한다.
- update mechanism이 없으면 install guide와 manual refresh path를 분리해서 기록한다.
- runtime-specific release 자동화는 공통 release flow에 바로 섞지 않고 adapter section으로 추가한다.

## Verification Plan

최소 preflight:

```bash
claude plugin validate . --strict
bun run typecheck
bun test hooks/hooks.test.ts src/mcp/server.test.ts src/mcp/server.lifecycle.test.ts
bun run build
bin/memmem --help
```

Codex-specific checks:

- `.codex-plugin/plugin.json`에 required `interface` object가 있는지 확인한다.
- manifest component paths가 plugin root 기준 `./`로 시작하는지 확인한다.
- `.agents/plugins/marketplace.json`의 local `source.path`가 marketplace root 기준 `./plugins/memmem`를 가리키는지 확인한다.

Claude-specific checks:

- `.claude-plugin/plugin.json`이 `--strict`에서 warning 없이 통과하는지 확인한다.
- `.claude-plugin/marketplace.json`의 plugin name/version/source가 manifest와 충돌하지 않는지 확인한다.
- local plugin 개발 중에는 `claude --plugin-dir .` 또는 marketplace local install로 smoke한다.

MCP smoke:

- `bin/memmem mcp`를 stdio process로 띄워 `tools/list` 응답을 확인한다.
- stdin close 후 process가 종료되는지 확인한다.

Future-runtime checks:

- 새 runtime adapter를 추가할 때는 manifest drift check, install smoke, MCP smoke 중 어떤 검증을 제공하는지 명시한다.
- 제공할 수 없는 검증은 "unsupported"로 기록하고, silent pass로 처리하지 않는다.
- 새 runtime 때문에 기존 Claude/Codex preflight가 느려지면 runtime별 check를 선택 실행할 수 있게 한다.

## Implementation Scope

첫 구현은 다음으로 제한한다.

1. `scripts/sync-plugin-versions.sh`를 metadata sync script로 확장한다.
2. runtime adapter 목록을 가진 manifest drift check script를 추가한다. 초기 adapter는 `claude`와 `codex`만 포함한다.
3. package scripts에 compatibility preflight를 추가한다.
4. README 또는 `scripts/README.md`에 Claude/Codex update semantics 차이를 기록한다.
5. hook root normalization을 검증한다. 현재 Codex가 `CLAUDE_PLUGIN_ROOT`를 compatibility env로 제공하는 것이 확인되면 문서화만 한다. 실제 smoke에서 누락되면 `bin/memmem` wrapper가 `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, executable location 순서로 root를 해석하도록 좁게 반영한다.

## 범위 밖

- Claude/Codex package 완전 분리
- single generated manifest 도입
- public marketplace submission 자동화
- Codex installed cache를 자동으로 직접 수정하는 스크립트
- Claude/Codex CLI 자체 업데이트 자동화
- Gemini 등 future runtime의 실제 manifest 구현. 이번 작업은 adapter를 추가하기 쉬운 구조까지만 만든다.

## 성공 기준

- 공통 metadata 변경 시 Claude/Codex manifest drift가 자동으로 잡힌다.
- release 전 한 명령으로 dual-runtime compatibility preflight를 실행할 수 있다.
- Claude validation, Codex manifest shape, MCP stdio lifecycle이 모두 검증된다.
- README 또는 scripts 문서만 봐도 Claude update와 Codex marketplace/cache refresh의 차이를 알 수 있다.
- future runtime은 기존 공통 payload를 복제하지 않고 adapter entry, manifest/check, docs section 추가로 확장할 수 있다.
- 기능 구현 없이도 현재 dual-runtime 배포 위험이 명확히 줄어든다.
