# Runtime Compatibility E2E Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude/Codex 런타임 호환성을 실제 프로세스 실행으로 검증하는 e2e 스모크 테스트를 `bun test`로 추가하고, CI에 `needs: build` 별도 job으로 붙인다.

**Architecture:** `src/e2e/runtime-compat.e2e.test.ts` 하나에 세 스모크(hooks 명령 실셸 실행 / MCP 기동+tools 목록 / CLI sync→read)를 담고, 각 케이스를 Codex env(`PLUGIN_ROOT`) / Claude env(`CLAUDE_PLUGIN_ROOT`) 대칭으로 돌린다. 자식 프로세스는 `node:child_process` spawn(기존 `server.lifecycle.test.ts` 패턴)으로 띄우고, 임시 `HOME`으로 격리해 실 DB·아카이브·LLM config를 건드리지 않는다. `plugins/memmem/` 미러는 `scripts/sync-codex-marketplace-plugin.sh`로 동기화한다.

**Tech Stack:** Bun 1.3.13, `bun test`, `node:child_process` spawn, `@modelcontextprotocol/sdk` client(stdio), GitHub Actions.

## Global Constraints

- **런타임은 항상 Bun.** CLI/MCP 번들은 `bun:sqlite`를 쓰므로 자식 프로세스는 `bun`(`process.execPath`)으로 실행한다. Node로 실행 금지.
- **실 DB·아카이브 절대 비파괴.** config/archive/db 경로는 `process.env.HOME` 기반(`src/core/paths.ts`의 `os.homedir()`, `src/core/llm/config.ts:129`의 `process.env.HOME`)으로 결정된다. e2e는 자식 프로세스 env의 `HOME`을 `fs.mkdtemp` 임시 디렉터리로 오버라이드한다. `initDatabase()` 호출 금지(테스트도 직접 호출 안 함 — 자식 프로세스가 `openDatabase()`를 쓴다).
- **네트워크/LLM 의존 0.** 임시 `HOME`에는 `config.json`이 없으므로 LLM 미설정 → extractor가 span을 skip(`spansSkipped` 증가, exit 0 유지). search는 e2e에서 검증하지 않는다(임베딩 모델 다운로드 회피).
- **테스트 파일 네이밍:** `*.e2e.test.ts`. CI e2e job은 `bun test src/e2e/`로 이 디렉터리만 실행한다. 기존 build job의 `bun test --jobs=1`은 전체를 도므로 e2e도 거기서 한 번 더 돌지만, 그건 허용(중복 실행은 무해, CI job 분리는 실패 격리가 목적).
- **빌드 선행 필수.** 모든 케이스는 `dist/cli-internal.mjs`, `dist/mcp-server.mjs`, `bin/memmem`이 빌드돼 있어야 한다. 로컬 실행 전 `bun run build`.
- **미러 동기화:** `src/`를 수정하면 `bash scripts/sync-codex-marketplace-plugin.sh`로 `plugins/memmem/`를 재생성해야 `compat:check`가 통과한다.

---

## File Structure

- **Create:** `src/e2e/runtime-compat.e2e.test.ts` — 세 스모크 시나리오, 두 런타임 env 대칭. 자식 프로세스 spawn 헬퍼 포함.
- **Modify:** `.github/workflows/ci.yml` — build job 뒤에 `e2e` job 추가(`needs: build`).
- **Generated (커밋 대상):** `plugins/memmem/src/e2e/runtime-compat.e2e.test.ts` — sync 스크립트가 복사. 수동 편집 금지.

검증 대상 메커니즘(읽기 전용 참조):
- `hooks/hooks.json` — `"${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/bin/memmem" sync --background`
- `src/cli/main.ts:148-170` — `spawnBackgroundSync()`는 자식을 `unref()`하고 부모는 즉시 exit 0. `read`는 `path --start-line N --end-line M`.
- `src/cli/mcp.ts` — `process.env.PLUGIN_ROOT` 기반 플러그인 루트 해석.

---

## Task 1: 자식 프로세스 헬퍼 + hooks 명령 실셸 스모크

**Files:**
- Create: `src/e2e/runtime-compat.e2e.test.ts`
- Test: 같은 파일 (e2e 테스트 자체가 deliverable)

**Interfaces:**
- Consumes: `dist/cli-internal.mjs`(빌드 산출물), `bin/memmem`, `hooks/hooks.json`.
- Produces: 이 파일 안에서 다음 Task가 재사용할 상수/헬퍼:
  - `REPO_ROOT: string` — repo 루트 절대경로
  - `BIN: string` — `bin/memmem` 절대경로
  - `CLI_BUNDLE: string` — `dist/cli-internal.mjs` 절대경로
  - `MCP_BUNDLE: string` — `dist/mcp-server.mjs` 절대경로
  - `RUNTIME_ENVS: ReadonlyArray<[label: string, env: Record<string,string|undefined>]>` — `[['codex', {PLUGIN_ROOT: REPO_ROOT, CLAUDE_PLUGIN_ROOT: undefined}], ['claude', {CLAUDE_PLUGIN_ROOT: REPO_ROOT, PLUGIN_ROOT: undefined}]]`
  - `makeTmpHome(): string` / `cleanup(tmpHome: string): void`
  - `runToCompletion(cmd: string[], env: Record<string,string|undefined>, timeoutMs: number): Promise<{ code: number|null; stdout: string; stderr: string }>`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/e2e/runtime-compat.e2e.test.ts` 생성:

```typescript
/**
 * Runtime compatibility e2e smoke tests.
 *
 * Verifies memmem behaves identically when only Codex's PLUGIN_ROOT or only
 * Claude's CLAUDE_PLUGIN_ROOT is set — the single runtime env-var difference.
 * Spawns real bin/memmem and dist bundles as child processes; isolates HOME to
 * a temp dir so the real DB/archive/LLM config are never touched.
 */
import { describe, test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const BIN = join(REPO_ROOT, 'bin', 'memmem');
const CLI_BUNDLE = join(REPO_ROOT, 'dist', 'cli-internal.mjs');
const MCP_BUNDLE = join(REPO_ROOT, 'dist', 'mcp-server.mjs');

const RUNTIME_ENVS: ReadonlyArray<readonly [string, Record<string, string | undefined>]> = [
  ['codex', { PLUGIN_ROOT: REPO_ROOT, CLAUDE_PLUGIN_ROOT: undefined }],
  ['claude', { CLAUDE_PLUGIN_ROOT: REPO_ROOT, PLUGIN_ROOT: undefined }],
];

function makeTmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'memmem-e2e-'));
}
function cleanup(tmpHome: string): void {
  rmSync(tmpHome, { recursive: true, force: true });
}

/** Run a child to completion with a hard timeout; SIGKILL + reject on hang. */
function runToCompletion(
  cmd: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (c) => (stdout += c.toString()));
    child.stderr!.on('data', (c) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process timed out after ${timeoutMs}ms: ${cmd.join(' ')}`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('hooks.json command runs under each runtime env', () => {
  // The literal command shape from hooks/hooks.json. We exec it via `sh -c`
  // exactly as a runtime's shell would, so the ${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}
  // expansion is what we're actually testing.
  const HOOK_COMMAND = JSON.parse(
    readFileSync(join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf-8'),
  ).hooks.SessionStart[0].hooks[0].command as string;

  test.each(RUNTIME_ENVS)('%s env: hook command exits 0', async (_label, runtimeEnv) => {
    const tmpHome = makeTmpHome();
    try {
      const { code } = await runToCompletion(
        ['sh', '-c', HOOK_COMMAND],
        { ...runtimeEnv, HOME: tmpHome },
        20_000,
      );
      expect(code).toBe(0);
    } finally {
      cleanup(tmpHome);
    }
  }, 30_000);
});
```

- [ ] **Step 2: 테스트 실패 확인 (빌드 안 된 상태 가정)**

Run: `rm -rf dist bin && bun test src/e2e/runtime-compat.e2e.test.ts`
Expected: FAIL — `bin/memmem`이 없어 hook 명령이 비정상 종료(code ≠ 0) 또는 spawn 실패.

- [ ] **Step 3: 빌드해서 통과시키기 (구현은 빌드 산출물)**

이 테스트의 "구현"은 빌드다. 프로덕션 코드 변경 없음.

Run: `bun run build`
Expected: `dist/cli-internal.mjs`, `bin/memmem` 생성.

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test src/e2e/runtime-compat.e2e.test.ts`
Expected: PASS — `codex env: hook command exits 0`, `claude env: hook command exits 0` 둘 다 통과.

- [ ] **Step 5: 미러 동기화 + 커밋**

```bash
bash scripts/sync-codex-marketplace-plugin.sh
bun run compat:check
git add src/e2e/runtime-compat.e2e.test.ts plugins/memmem/src/e2e/runtime-compat.e2e.test.ts
git commit -m "test(e2e): hooks command runs under codex and claude runtime env"
```
Expected: `compat:check` → `PASS: runtime compatibility manifests are valid`.

---

## Task 2: CLI sync→read 스모크 (LLM/네트워크 없이)

**Files:**
- Modify: `src/e2e/runtime-compat.e2e.test.ts` (describe 블록 추가)

**Interfaces:**
- Consumes: Task 1의 `BIN`, `RUNTIME_ENVS`, `makeTmpHome`, `cleanup`, `runToCompletion`.
- Produces: 없음(최종 deliverable 단계).

배경(검증된 동작): 임시 `HOME` + Claude transcript fixture로 `bin/memmem sync`를 돌리면 LLM 미설정이라 extractor는 span을 skip하지만 **sync는 exit 0, archive 파일을 생성**한다. 그 archive 파일을 `read --start-line 1 --end-line N`으로 읽으면 렌더된 텍스트(`# Conversation`)가 나온다. search는 검증하지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/e2e/runtime-compat.e2e.test.ts`에 describe 추가:

```typescript
describe('CLI sync then read works under each runtime env (no LLM, no network)', () => {
  /** Write a minimal two-line Claude transcript into an isolated CLAUDE_CONFIG_DIR. */
  function seedClaudeTranscript(claudeConfigDir: string): void {
    const projDir = join(claudeConfigDir, 'projects', 'demo');
    mkdirSync(projDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'e2e smoke transcript' },
        timestamp: '2026-06-26T00:00:00Z',
        sessionId: 's-e2e',
        cwd: '/tmp',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'smoke reply' }] },
        timestamp: '2026-06-26T00:00:01Z',
        sessionId: 's-e2e',
        cwd: '/tmp',
      }),
    ];
    writeFileSync(join(projDir, 's-e2e.jsonl'), lines.join('\n') + '\n');
  }

  /** Find the first archived transcript file under the isolated HOME. */
  function findArchiveFile(tmpHome: string): string | null {
    const base = join(tmpHome, '.config', 'memmem', 'conversation-archive');
    if (!existsSync(base)) return null;
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith('.jsonl')) return full;
      }
    }
    return null;
  }

  test.each(RUNTIME_ENVS)('%s env: sync archives and read renders it', async (_label, runtimeEnv) => {
    const tmpHome = makeTmpHome();
    try {
      const claudeConfigDir = join(tmpHome, 'claude');
      const codexHome = join(tmpHome, 'codex');
      mkdirSync(codexHome, { recursive: true });
      seedClaudeTranscript(claudeConfigDir);

      const childEnv = {
        ...runtimeEnv,
        HOME: tmpHome,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        CODEX_HOME: codexHome,
      };

      // sync (foreground): exits 0 and writes an archive file even with no LLM.
      const sync = await runToCompletion([BIN, 'sync'], childEnv, 60_000);
      expect(sync.code).toBe(0);

      const archiveFile = findArchiveFile(tmpHome);
      expect(archiveFile).not.toBeNull();

      // read: renders the archived transcript lines.
      const read = await runToCompletion(
        [BIN, 'read', archiveFile!, '--start-line', '1', '--end-line', '2'],
        childEnv,
        20_000,
      );
      expect(read.code).toBe(0);
      expect(read.stdout).toContain('# Conversation');
    } finally {
      cleanup(tmpHome);
    }
  }, 90_000);

  test.each(RUNTIME_ENVS)('%s env: background sync parent exits 0', async (_label, runtimeEnv) => {
    const tmpHome = makeTmpHome();
    try {
      // --background detaches a child (unref) and the parent returns immediately.
      // We only assert the parent's exit code; the detached child needs an
      // embedding model and is intentionally not awaited (would be flaky).
      const { code } = await runToCompletion(
        [BIN, 'sync', '--background'],
        { ...runtimeEnv, HOME: tmpHome },
        20_000,
      );
      expect(code).toBe(0);
    } finally {
      cleanup(tmpHome);
    }
  }, 30_000);
});
```

- [ ] **Step 2: 테스트 실패 확인 (의도적 회귀로 검증)**

먼저 정상 통과를 확인한 뒤, env 격리가 진짜 동작하는지 reproduce하기 위해 임시로 `seedClaudeTranscript` 호출을 주석 처리하고 실행.

Run: `bun test src/e2e/runtime-compat.e2e.test.ts -t "sync archives and read"`
Expected: FAIL — transcript가 없어 archive 파일이 안 생기고 `expect(archiveFile).not.toBeNull()`에서 실패. 확인 후 주석 원복.

- [ ] **Step 3: 구현 (빌드 산출물 — 이미 빌드됨)**

프로덕션 코드 변경 없음. Task 1에서 빌드된 `bin/memmem`이 그대로 동작.

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test src/e2e/runtime-compat.e2e.test.ts`
Expected: PASS — 6개 케이스(hooks 2 + sync/read 2 + background 2) 모두 통과.

- [ ] **Step 5: 미러 동기화 + 커밋**

```bash
bash scripts/sync-codex-marketplace-plugin.sh
bun run compat:check
git add src/e2e/runtime-compat.e2e.test.ts plugins/memmem/src/e2e/runtime-compat.e2e.test.ts
git commit -m "test(e2e): cli sync archives and read renders under both runtime envs"
```
Expected: `compat:check` PASS.

---

## Task 3: MCP 기동 + tools/list 스모크

**Files:**
- Modify: `src/e2e/runtime-compat.e2e.test.ts` (describe 블록 추가)

**Interfaces:**
- Consumes: Task 1의 `MCP_BUNDLE`, `RUNTIME_ENVS`, `makeTmpHome`, `cleanup`. `@modelcontextprotocol/sdk` client(이미 설치됨: `node_modules/@modelcontextprotocol/sdk/dist/esm/client/{index,stdio}.js`).
- Produces: 없음(최종 단계).

배경: `StdioClientTransport`가 MCP 서버 프로세스를 spawn하고 `initialize` 핸드셰이크를 자동 처리한다. `client.listTools()`로 `search`, `read` tool 존재를 확인한다. `command: 'bun'`, `args: [MCP_BUNDLE]`로 띄우되 env에 임시 `HOME`을 넣어 격리한다.

- [ ] **Step 1: 실패하는 테스트 작성**

파일 상단 import에 추가:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
```

describe 추가:

```typescript
describe('MCP server starts and lists tools under each runtime env', () => {
  test.each(RUNTIME_ENVS)('%s env: initialize + tools/list returns search and read', async (_label, runtimeEnv) => {
    const tmpHome = makeTmpHome();
    let client: Client | null = null;
    try {
      const transport = new StdioClientTransport({
        command: 'bun',
        args: [MCP_BUNDLE],
        env: {
          ...(process.env as Record<string, string>),
          ...(runtimeEnv as Record<string, string>),
          HOME: tmpHome,
        },
      });
      client = new Client({ name: 'memmem-e2e', version: '1.0.0' });
      await client.connect(transport); // performs the initialize handshake

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('search');
      expect(names).toContain('read');
    } finally {
      await client?.close();
      cleanup(tmpHome);
    }
  }, 30_000);
});
```

- [ ] **Step 2: 테스트 실패 확인**

MCP 번들이 없을 때 실패하는지 확인.

Run: `mv dist/mcp-server.mjs dist/mcp-server.mjs.bak && bun test src/e2e/runtime-compat.e2e.test.ts -t "tools/list" ; mv dist/mcp-server.mjs.bak dist/mcp-server.mjs`
Expected: FAIL — 번들이 없어 `client.connect`가 실패(spawn error 또는 핸드셰이크 타임아웃). 확인 후 번들 원복(명령에 포함됨).

- [ ] **Step 3: 구현 (빌드 산출물 — 이미 빌드됨)**

프로덕션 코드 변경 없음. `dist/mcp-server.mjs`가 그대로 동작.

- [ ] **Step 4: 테스트 통과 확인**

Run: `bun test src/e2e/runtime-compat.e2e.test.ts`
Expected: PASS — 8개 케이스 전부(hooks 2 + sync/read 2 + background 2 + mcp 2) 통과.

- [ ] **Step 5: 미러 동기화 + 커밋**

```bash
bash scripts/sync-codex-marketplace-plugin.sh
bun run compat:check
git add src/e2e/runtime-compat.e2e.test.ts plugins/memmem/src/e2e/runtime-compat.e2e.test.ts
git commit -m "test(e2e): mcp server starts and lists tools under both runtime envs"
```
Expected: `compat:check` PASS.

---

## Task 4: CI e2e job 추가

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: 기존 `build` job.
- Produces: 없음.

기존 `ci.yml`은 단일 `build` job이다. e2e를 `needs: build`인 별도 job으로 추가한다. e2e job은 빌드를 다시 한다(빌드가 빠르고, artifact 전달의 권한 비트 손실/복잡도를 피함).

- [ ] **Step 1: e2e job 추가**

`.github/workflows/ci.yml`의 `build` job 아래(파일 끝)에 추가:

```yaml
  e2e:
    needs: build
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile --ignore-scripts

      - name: Install native sqlite-vec for Linux
        run: bun add -d sqlite-vec-linux-x64 --ignore-scripts

      - name: Build
        run: bun run build

      - name: Runtime compatibility e2e
        run: bun test src/e2e/
```

- [ ] **Step 2: 워크플로 YAML 유효성 확인**

Run: `bun -e "import {parse} from 'yaml'; parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log('valid')"` (yaml 미설치 시 대안: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('valid')"`)
Expected: `valid`.

- [ ] **Step 3: e2e 테스트가 로컬에서 그린인지 최종 확인**

Run: `bun run build && bun test src/e2e/`
Expected: PASS — 8개 케이스 전부.

- [ ] **Step 4: 미러 동기화 불필요 확인 + 커밋**

`.github/workflows/ci.yml`은 미러(`plugins/memmem/`)에 복사되지 않는 파일이므로 sync 스크립트 재실행 불필요. 단, `compat:check`로 회귀 없음만 확인.

```bash
bun run compat:check
git add .github/workflows/ci.yml
git commit -m "ci: add runtime compatibility e2e job"
```
Expected: `compat:check` PASS.

---

## Self-Review

**Spec coverage:**
- 스펙 "실제 호환성 지점"(env var 차이 → hooks 명령 / MCP 런처) → Task 1(hooks), Task 3(MCP). ✓
- 스펙 "범위" 3개 시나리오(hooks 실셸 / MCP 기동+tools / CLI sync→read, search 제외) → Task 1, 3, 2. ✓
- 스펙 "안정성"(HOME 격리, LLM 미설정 skip, 네트워크 0, 타임아웃) → Global Constraints + `runToCompletion` 타임아웃 + `--background` 부모만 검증. ✓
- 스펙 "구현 형태"(`src/e2e/*.e2e.test.ts`, Bun.spawn, 미러 동기화) → 전 Task. node:child_process spawn 사용(기존 `server.lifecycle.test.ts` 검증된 패턴, Bun.spawn보다 타임아웃 제어 확실). ✓
- 스펙 "CI"(`needs: build` 별도 job) → Task 4. ✓
- 스펙 "성공 기준"(로컬 통과 / env 깨면 실패 reproduce / 결정론 / compat:check 통과) → Task 1·2·3 Step 2(reproduce), Step 5(compat:check). ✓

**Placeholder scan:** 모든 코드 블록은 실제 실행 가능한 전체 코드. TBD/TODO 없음. ✓

**Type consistency:** `RUNTIME_ENVS`, `makeTmpHome`, `cleanup`, `runToCompletion`, `BIN`, `MCP_BUNDLE`가 Task 1에서 정의되고 Task 2·3에서 동일 시그니처로 사용. read 인자 `--start-line`/`--end-line`은 `src/cli/main.ts:82` 파서와 일치. `spansSkipped`는 검증하지 않고 exit code/archive 존재만 본다(스펙대로). ✓
