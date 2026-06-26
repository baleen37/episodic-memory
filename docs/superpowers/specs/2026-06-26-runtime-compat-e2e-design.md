# Claude/Codex 런타임 호환성 E2E 스모크 설계

날짜: 2026-06-26

## 문제

memmem은 Claude Code와 Codex 양쪽에서 같은 기능을 제공해야 한다. 기존 `compat:check`(`scripts/verify-runtime-compatibility.test.sh`)는 **정적** 검증만 한다 — 매니페스트 JSON 필드, 미러 디렉터리(`plugins/memmem/`)의 파일/트리 드리프트, MCP 런처의 `process.env.PLUGIN_ROOT` 문자열 존재 여부.

정적 검증은 "파일에 올바른 문자열이 있는가"는 보지만, "그 환경변수 하나만 세팅했을 때 실제로 끝까지 도는가"는 검증하지 못한다. 즉 hooks 명령 실행, MCP 기동, CLI 플로우가 런타임별 환경에서 실제로 동작하는지는 비어 있다.

이 작업은 그 빈틈을 채우는 **런타임 스모크 e2e**를 추가하고 CI에 별도 job으로 붙인다. `2026-06-21-dual-runtime-plugin-compatibility-design.md`의 정적 contract에 대한 동적(runtime) 후속이다.

## 실제 호환성 지점

코드 조사 결과 Claude와 Codex의 런타임 차이는 **플러그인 루트를 가리키는 환경변수 이름 하나**다.

- Claude: `CLAUDE_PLUGIN_ROOT`
- Codex: `PLUGIN_ROOT`

이 차이가 흘러가는 두 경로:

1. **hooks 명령** (`hooks/hooks.json`) — `"${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/bin/memmem" sync --background`. 셸이 env var로 bin 경로를 해석한다. `bin/memmem` 내부 로직은 이 차이에 무관하며, 차이는 전적으로 셸 변수 확장에서 흡수된다.
2. **MCP 런처** (`src/cli/mcp.ts`) — `process.env.PLUGIN_ROOT`를 읽어 플러그인 루트를 결정한다.

따라서 e2e는 "각 런타임의 env var **만** 세팅했을 때 두 경로가 대칭적으로 동작하는가"를 증명하는 것이 목표다.

## 범위

검증한다 (스모크 묶음, 각 케이스를 Codex env / Claude env 대칭으로):

1. **hooks 명령 실셸 실행** — `hooks/hooks.json`의 SessionStart/Stop 명령 문자열을 실제 셸(`sh -c`)로, 각 런타임 env var만 세팅해 실행 → exit 0.
2. **MCP 기동** — `bin/memmem mcp`를 각 런타임 env로 기동 → MCP `initialize` 핸드셰이크 성공 + `tools/list`에 `search`, `read` 존재.
3. **CLI 플로우** — fixture archive를 임시 config 경로에 두고 `sync`(exit 0 + archive 파일 생성) → `read`(archive 라인 출력). **search는 제외** (별도 spawn 프로세스라 임베딩 모델 모킹이 안 통하고, 의미적 정확도는 이미 `src/core/search.test.ts`가 mock으로 커버).

검증하지 않는다:

- search의 의미적 정확도 (기존 단위 테스트 책임)
- LLM 추출 정확도 (CI에 프로바이더 미설정; 의도된 skip)
- 임베딩 모델의 실제 동작 (네트워크 의존 차단)

## 안정성 (flaky 방지)

CI에서 결정론적으로 돌기 위한 제약. 메모리 교훈 `initdatabase-wipes-real-db`를 따른다.

- **격리**: `HOME`(및 필요 시 config 경로 env)을 임시 디렉터리로 오버라이드. 실 DB·아카이브(`~/.config/memmem/`)를 절대 건드리지 않는다.
- **LLM 미설정**: config에 `llm` 섹션을 두지 않는다. extractor가 span을 skip(설계상 failure-tolerant)하고 sync는 여전히 exit 0.
- **네트워크 의존 0**: search를 e2e에서 제외하므로 임베딩 모델 다운로드가 불필요. fixture archive는 read만 검증.
- **타임아웃**: MCP 기동 케이스는 핸드셰이크 응답에 명시적 타임아웃을 두고, 실패 시 spawn 프로세스를 정리한다.

## 구현 형태

- **파일**: `src/e2e/runtime-compat.e2e.test.ts` — `bun test`로 작성. `Bun.spawn`으로 `bin/memmem` 및 hooks 명령을 자식 프로세스로 실행하고 stdout/exit code를 assert.
- 프로젝트 테스트 컨벤션(`**/*.test.ts`, `bun test`)과 일치. `.e2e.test.ts` 네이밍으로 e2e임을 표시.
- **미러 동기화**: `plugins/memmem/`는 빌드/동기화 파이프라인이 루트 트리를 복사한 사본이며, `compat:check`가 `src/` 트리 드리프트까지 검사한다. 새 e2e 파일은 루트와 미러 양쪽에 동일하게 존재해야 `compat:check`가 통과한다. 파이프라인이 미러를 자동 생성하면 그것에 맡기고, 아니면 동일 복사한다.

## CI

`ci.yml`에 별도 job 추가. build job 다음에 `needs: build`로 의존시켜, 빌드 실패와 e2e 실패를 GitHub UI에서 명확히 구분한다.

```yaml
e2e:
  needs: build
  runs-on: ubuntu-latest
  steps:
    - checkout
    - setup-bun
    - install deps (+ native sqlite-vec for Linux)
    - build
    - run: bun test src/e2e/runtime-compat.e2e.test.ts
```

`compat:check`(정적)는 기존 build job에 그대로 둔다. e2e는 그 위에 얹는 런타임 검증이다.

## 성공 기준

- `bun test src/e2e/runtime-compat.e2e.test.ts`가 로컬에서 통과.
- CI e2e job이 통과하고, env var를 의도적으로 깨뜨리면(예: 둘 다 unset) 실패한다 — 즉 실제로 호환성을 검증함을 reproduce 가능.
- 네트워크/LLM 없이 결정론적으로 통과.
- `compat:check`가 e2e 파일 추가 후에도 통과 (미러 드리프트 없음).
