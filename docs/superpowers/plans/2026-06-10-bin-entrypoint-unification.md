# bin/ 단일 진입점 통일 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** memmem의 CLI/hook/MCP 세 진입점을 `bin/memmem` 단일 실행파일로 통일하고, `CLAUDE_PLUGIN_ROOT` 우회 로직(`resolve-plugin-root.sh`, `run.sh`, `start-mcp-server.sh`, `mcp-server-wrapper.mjs`)을 제거한다.

**Architecture:** 빌드가 `bin/memmem`(graceful wrapper, shebang 실행파일)과 그 본체 번들을 출력한다. Claude Code가 `bin/`을 Bash PATH에 자동 등록하고 hook/MCP는 `${CLAUDE_PLUGIN_ROOT}/bin/memmem`로 호출한다. MCP 서버 기동은 신설 `memmem mcp` 서브커맨드가 담당한다.

**Tech Stack:** TypeScript, Bun (`bun:sqlite`, `bun test`, `Bun.build`), POSIX sh.

**검증된 전제 (실측 완료, Claude Code 2.1.170):** hook subprocess의 `CLAUDE_PLUGIN_ROOT` 채워짐 / `bin/` Bash PATH 자동 등록 동작 / `.mcp.json` command의 `${CLAUDE_PLUGIN_ROOT}` 치환 지원.

---

## File Structure

| 파일 | 책임 | 변경 |
| ---- | ---- | ---- |
| `scripts/build.mjs` | 번들 빌드 + 출력 배치 | 출력을 `dist/cli.mjs` → `bin/memmem`, `dist/cli-internal.mjs` → `dist/cli-internal.mjs`(유지), MCP wrapper 복사 제거 |
| `src/cli-graceful.mjs` | 첫 실행 의존성 안전장치 + 본체 import | `bin/memmem`로 빌드 출력 (소스는 그대로), import 경로 갱신 |
| `src/cli/main.ts` | CLI 라우터 | `mcp` 서브커맨드 추가 |
| `src/cli/mcp.ts` (신규) | `memmem mcp` 핸들러 = MCP 부트스트랩 + 서버 spawn | `mcp-server-wrapper.mjs` 로직 흡수 |
| `scripts/lib/check-dependencies.mjs` | deps/build 체크 | 번들 경로 참조 유지 (변경 최소) |
| `hooks/hooks.json` | hook 정의 | `run.sh` → `bin/memmem sync` |
| `.mcp.json` | MCP 서버 정의 | `${CLAUDE_PLUGIN_ROOT}/bin/memmem mcp` |
| `package.json` | npm bin | `dist/cli.mjs` → `bin/memmem` |
| `.gitignore` | 빌드 산출물 무시 | `bin/` 추가 |
| `hooks/hooks.test.ts` | 진입점 회귀 가드 | 새 구조 기대값으로 갱신 |
| 삭제 | — | `hooks/run.sh`, `scripts/resolve-plugin-root.sh`, `scripts/start-mcp-server.sh`, `scripts/mcp-server-wrapper.mjs` |

**핵심 결정 — 번들 본체 위치:** `bin/memmem`(graceful)이 import하는 CLI 본체는 `dist/cli-internal.mjs`에 유지한다. graceful은 `import.meta.url` 기준 `../dist/cli-internal.mjs`를 가리킨다. MCP 서버 번들은 `dist/mcp-server.mjs`에 유지한다. 즉 `bin/`에는 `memmem` 실행파일 하나만, 번들들은 `dist/`에 둔다 → 진입점만 `bin/`으로 통일.

---

## Task 1: `hooks.test.ts`를 새 진입점 구조 기대값으로 갱신 (빨강)

진입점 회귀 가드 테스트를 먼저 새 구조로 바꿔 실패하게 만든다 (TDD 빨강). 이후 태스크가 이 테스트를 초록으로 만든다.

**Files:**
- Modify: `hooks/hooks.test.ts`

- [ ] **Step 1: hook command 기대값을 bin/memmem으로 변경**

`hooks/hooks.test.ts`에서 `'sh ${CLAUDE_PLUGIN_ROOT}/hooks/run.sh sync'`가 등장하는 4곳(line 48, 66, 89, 90)을 모두 `'${CLAUDE_PLUGIN_ROOT}/bin/memmem sync'`로 교체한다.

line 46-49:
```ts
    expect(hook).toEqual({
      type: 'command',
      command: '${CLAUDE_PLUGIN_ROOT}/bin/memmem sync',
    });
```

line 64-67:
```ts
    expect(hook).toEqual({
      type: 'command',
      command: '${CLAUDE_PLUGIN_ROOT}/bin/memmem sync',
    });
```

line 88-91:
```ts
    expect(commands).toEqual([
      '${CLAUDE_PLUGIN_ROOT}/bin/memmem sync',
      '${CLAUDE_PLUGIN_ROOT}/bin/memmem sync',
    ]);
```

- [ ] **Step 2: 진입점 파일 참조 테스트를 새 구조로 교체**

`'runs Bun-only CLI entrypoints with bun'` 테스트(line 100-108)를 삭제하고, 아래 테스트로 교체한다. `run.sh`와 `dist/cli.mjs`는 더 이상 존재하지 않으므로 `bin/memmem` shebang을 검증한다:

```ts
  it('builds bin/memmem as a bun shebang executable', () => {
    const graceful = readRepoFile('src/cli-graceful.mjs');

    expect(graceful.startsWith('#!/usr/bin/env bun')).toBe(true);
    expect(graceful).toContain("error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND'");
  });
```

- [ ] **Step 3: MCP 진입점 테스트를 새 구조로 교체**

`'runs the MCP server bundle with bun'` 테스트(line 110-118)를 아래로 교체한다. `.mcp.json`이 `bin/memmem mcp`를 가리키는지 검증:

```ts
  it('routes MCP through bin/memmem mcp subcommand', () => {
    const mcpConfig = JSON.parse(readRepoFile('.mcp.json'));

    expect(mcpConfig.mcpServers.memmem.command).toBe('${CLAUDE_PLUGIN_ROOT}/bin/memmem');
    expect(mcpConfig.mcpServers.memmem.args).toEqual(['mcp']);
  });
```

- [ ] **Step 4: 테스트 실행하여 실패 확인**

Run: `bun test hooks/hooks.test.ts`
Expected: FAIL — hook command 기대값 불일치 및 `.mcp.json`/`cli-graceful.mjs` 기대값 불일치로 여러 테스트 실패.

- [ ] **Step 5: 커밋**

```bash
git add hooks/hooks.test.ts
git commit -m "test: bin/memmem 단일 진입점 기대값으로 갱신 (빨강)"
```

---

## Task 2: `memmem mcp` 서브커맨드 신설

`scripts/mcp-server-wrapper.mjs`의 부트스트랩(deps 설치 → 빌드 → `bun dist/mcp-server.mjs` spawn)을 CLI 핸들러로 옮긴다.

**Files:**
- Create: `src/cli/mcp.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: MCP 핸들러 작성**

Create `src/cli/mcp.ts`:

```ts
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  checkDependencies,
  checkBuildNeeded,
  installDependencies,
  runBuild,
  analyzeError,
} from '../../scripts/lib/check-dependencies.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || resolve(__dirname, '..', '..');

async function ensureDependenciesAndBuild(): Promise<void> {
  const { installed } = checkDependencies();
  if (!installed) {
    console.error('[memmem] Installing dependencies (first run only)...');
    await installDependencies(false);
  }

  const { needsBuild, reason } = checkBuildNeeded();
  if (needsBuild) {
    console.error(`[memmem] Building plugin (${reason})...`);
    await runBuild();
  }
}

export async function runMcpCli(): Promise<void> {
  try {
    await ensureDependenciesAndBuild();
  } catch (error) {
    const analysis = analyzeError(error as Error);
    console.error('[memmem] ERROR: setup failed.');
    console.error(`Cause: ${analysis.cause}`);
    console.error(`Fix: ${analysis.fix}`);
    process.exit(1);
  }

  const mcpServerPath = join(PLUGIN_ROOT, 'dist', 'mcp-server.mjs');
  if (!existsSync(mcpServerPath)) {
    console.error(`[memmem] ERROR: MCP server not found at ${mcpServerPath}`);
    console.error('Please run: bun run build');
    process.exit(1);
  }

  // bun:sqlite를 import하므로 반드시 bun으로 spawn.
  const child = spawn('bun', [mcpServerPath], { stdio: 'inherit', shell: false });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error(`[memmem] ERROR: Failed to start MCP server: ${err.message}`);
    process.exit(1);
  });
}
```

- [ ] **Step 2: main.ts 라우터에 mcp 케이스 추가**

`src/cli/main.ts` line 1-6 import 블록 끝에 추가:
```ts
import { runMcpCli } from './mcp.js';
```

`src/cli/main.ts` line 166-168 `doctor` 케이스 뒤, `default` 앞에 추가:
```ts
    case 'mcp':
      await runMcpCli();
      break;
```

- [ ] **Step 3: help 텍스트에 mcp 추가**

`src/cli/main.ts` line 109-115 COMMANDS 블록의 `doctor` 줄 뒤에 추가:
```
  mcp       Start the MCP server (used by .mcp.json)
```

- [ ] **Step 4: 타입체크**

Run: `bun run typecheck`
Expected: PASS (no errors)

- [ ] **Step 5: 커밋**

```bash
git add src/cli/mcp.ts src/cli/main.ts
git commit -m "feat: memmem mcp 서브커맨드 추가 (MCP 부트스트랩 흡수)"
```

---

## Task 3: graceful wrapper import 경로 검증 및 빌드 출력 변경

`bin/memmem`을 빌드 출력으로 만들고 graceful이 본체를 올바르게 가리키게 한다.

**Files:**
- Modify: `scripts/build.mjs`
- Modify: `src/cli-graceful.mjs` (import 경로만)

- [ ] **Step 1: graceful의 본체 경로 확인**

`src/cli-graceful.mjs` line 13은 이미 `resolve(__dirname, 'cli-internal.mjs')`이다. 빌드 시 `bin/memmem`과 `dist/cli-internal.mjs`는 다른 디렉터리이므로 경로를 `resolve(__dirname, '..', 'dist', 'cli-internal.mjs')`로 변경한다:

line 12-13:
```js
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, '..', 'dist', 'cli-internal.mjs');
```

- [ ] **Step 2: graceful의 check-dependencies import 경로 확인**

`src/cli-graceful.mjs` line 8은 `'../scripts/lib/check-dependencies.mjs'`. `bin/memmem`에서 보면 `../scripts/lib/...`가 맞다 (plugin root 기준 `bin/` → `../scripts/`). 변경 불필요. 확인만.

- [ ] **Step 3: build.mjs가 bin/memmem을 출력하도록 변경**

`scripts/build.mjs` line 46-73 `buildCli()` 함수를 아래로 교체한다:

```js
async function buildCli() {
  await mkdir("dist", { recursive: true });
  await mkdir("bin", { recursive: true });

  try {
    await buildEntry("src/cli/main.ts", "dist/cli-internal.mjs");
    await buildEntry("src/mcp/server.ts", "dist/mcp-server.mjs");

    // bin/memmem = graceful wrapper executable (bun shebang).
    const graceful = await Bun.file(join("src", "cli-graceful.mjs")).text();
    await writeFile(join("bin", "memmem"), graceful);
    await chmod(join("bin", "memmem"), 0o755);
    console.log("✓ Built bin/memmem (graceful executable)");

    console.log("\n✅ Build complete!");
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}
```

- [ ] **Step 4: build.mjs import에 chmod 추가**

`scripts/build.mjs` line 7을 변경:
```js
import { mkdir, copyFile, writeFile, chmod } from "fs/promises";
```
(`copyFile`은 더 이상 안 쓰이면 제거: `import { mkdir, writeFile, chmod } from "fs/promises";`)

- [ ] **Step 5: 빌드 실행**

Run: `bun run build`
Expected:
```
✓ Built dist/cli-internal.mjs
✓ Built dist/mcp-server.mjs
✓ Built bin/memmem (graceful executable)
✅ Build complete!
```

- [ ] **Step 6: bin/memmem 직접 실행 확인**

Run: `bin/memmem --help`
Expected: help 텍스트 출력 (mcp 커맨드 포함), exit 0.

Run: `bin/memmem mcp` 는 서버를 띄우므로 생략하거나 즉시 Ctrl-C. 대신 doctor로 확인:
Run: `bin/memmem doctor`
Expected: build/index/data 체크 출력.

- [ ] **Step 7: 커밋**

```bash
git add scripts/build.mjs src/cli-graceful.mjs
git commit -m "build: bin/memmem 실행파일 출력 (dist/cli.mjs 대체)"
```

---

## Task 4: hooks.json / .mcp.json / package.json 진입점 전환

**Files:**
- Modify: `hooks/hooks.json`
- Modify: `.mcp.json`
- Modify: `package.json`

- [ ] **Step 1: hooks.json을 bin/memmem로 변경**

`hooks/hooks.json` line 10과 line 20의 command를 변경:
```json
            "command": "${CLAUDE_PLUGIN_ROOT}/bin/memmem sync"
```
(`sh ` 접두사 제거 — `bin/memmem`은 shebang 실행파일)

- [ ] **Step 2: .mcp.json을 bin/memmem mcp로 변경**

`.mcp.json` 전체를 아래로 교체:
```json
{
  "mcpServers": {
    "memmem": {
      "command": "${CLAUDE_PLUGIN_ROOT}/bin/memmem",
      "args": ["mcp"]
    }
  }
}
```

- [ ] **Step 3: package.json bin 경로 변경**

`package.json`의 `"bin": { "memmem": "dist/cli.mjs" }`를 변경:
```json
  "bin": {
    "memmem": "bin/memmem"
  },
```

- [ ] **Step 4: hooks 테스트 실행 (초록 확인)**

Run: `bun test hooks/hooks.test.ts`
Expected: PASS — Task 1에서 갱신한 모든 기대값이 이제 일치.

- [ ] **Step 5: 커밋**

```bash
git add hooks/hooks.json .mcp.json package.json
git commit -m "feat: hook/MCP/npm 진입점을 bin/memmem로 전환"
```

---

## Task 5: 우회 로직 및 미사용 파일 삭제

**Files:**
- Delete: `hooks/run.sh`, `scripts/resolve-plugin-root.sh`, `scripts/start-mcp-server.sh`, `scripts/mcp-server-wrapper.mjs`

- [ ] **Step 1: 잔존 참조 확인**

Run: `grep -rn "run.sh\|resolve-plugin-root\|start-mcp-server\|mcp-server-wrapper" --include="*.ts" --include="*.mjs" --include="*.json" --include="*.sh" . | grep -v node_modules | grep -v dist/ | grep -v "\.git/" | grep -v docs/`
Expected: 출력 없음 (모든 참조가 이미 갱신됨). 출력이 있으면 그 파일을 먼저 정리.

- [ ] **Step 2: 파일 삭제**

```bash
git rm hooks/run.sh scripts/resolve-plugin-root.sh scripts/start-mcp-server.sh scripts/mcp-server-wrapper.mjs
```

- [ ] **Step 3: ensure-deps.sh 사용 여부 확인**

Run: `grep -rn "ensure-deps" --include="*.json" --include="*.sh" --include="*.mjs" . | grep -v node_modules | grep -v "\.git/"`
Expected: 참조 없으면 `git rm hooks/ensure-deps.sh`도 함께 삭제. 참조가 있으면 유지.

- [ ] **Step 4: 전체 테스트 실행**

Run: `bun test`
Expected: 전체 PASS. (특히 `hooks/hooks.test.ts` 포함)

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "chore: CLAUDE_PLUGIN_ROOT 우회 로직 제거 (bin/memmem로 통일)"
```

---

## Task 6: .gitignore에 bin/ 추가 및 최종 검증

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: .gitignore에 bin/ 추가**

`.gitignore`의 `# Build output` 섹션(`dist/` 줄 아래)에 추가:
```
dist/
bin/
```

- [ ] **Step 2: bin/이 추적되지 않는지 확인**

Run: `git status --short bin/`
Expected: 출력 없음 (bin/memmem이 ignore됨).

- [ ] **Step 3: CLAUDE.md / docs의 빌드 출력 설명 갱신 확인**

Run: `grep -rn "dist/cli.mjs\|cli-graceful\|mcp-server-wrapper\|cli.mjs" CLAUDE.md`
Expected: 일치하는 항목이 있으면 `bin/memmem` 기준으로 갱신. (CLAUDE.md의 "Build Output" 및 "Key Files" 섹션)

- [ ] **Step 4: 전체 빌드 + 타입체크 + 테스트 최종 확인**

Run: `bun run build && bun run typecheck && bun test`
Expected: 빌드 성공, 타입 에러 0, 전체 테스트 PASS.

- [ ] **Step 5: 커밋**

```bash
git add .gitignore CLAUDE.md
git commit -m "chore: bin/ gitignore 추가 및 빌드 출력 문서 갱신"
```

---

## Task 7: 설치본 반영 및 실제 진입점 동작 검증

빌드 산출물이 git에 없으므로(gitignore), 실제 동작은 설치본 캐시에서 검증한다. 코드 변경이 끝난 뒤 한 번 수행.

**Files:** 없음 (검증 전용)

- [ ] **Step 1: 설치본 동기화 방식 결정**

설치본(`~/.claude/plugins/cache/baleen-marketplace/memmem/1.5.0`)은 로컬 repo와 별개다. 실제 검증은 마켓플레이스 재설치 또는 로컬 변경을 설치본에 반영한 뒤 `bun run build`로 한다. 이 플랜 범위에서는 로컬 repo 빌드 + `bin/memmem` 직접 호출로 동작을 확인하고, 설치본 반영은 배포 단계로 분리한다.

- [ ] **Step 2: bare 명령 동작 확인 (로컬)**

Run: `bin/memmem doctor`
Expected: build/index/data 진단 출력.

- [ ] **Step 3: hook 명령 형태 검증**

Run: `CLAUDE_PLUGIN_ROOT="$(pwd)" sh -c '${CLAUDE_PLUGIN_ROOT}/bin/memmem --help' 2>&1 | head -5`
Expected: help 출력 (hook이 쓰는 `${CLAUDE_PLUGIN_ROOT}/bin/memmem` 호출 형태가 동작).

- [ ] **Step 4: 최종 상태 확인**

Run: `git log --oneline -8 && git status`
Expected: Task 1-6 커밋들이 보이고, working tree clean (bin/, dist/는 ignore).
