# MCP 서버 고아 프로세스 방지 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** claude 세션이 시그널 없이 비정상 종료될 때 memmem MCP 서버(부모·자식)가 stdin EOF를 감지해 스스로 종료하도록 하여 고아 프로세스 누적을 방지한다.

**Architecture:** 두 계층에 stdin `'close'` 핸들러를 추가한다. 자식(`dist/mcp-server.mjs` ← `src/mcp/server.ts`)은 stdin이 닫히면 `process.exit(0)`. 부모(`bin/memmem mcp` ← `src/cli/mcp.ts`)는 stdin이 닫히면 자식을 `SIGTERM`으로 kill. `stdio: 'inherit'` 구조에서 어느 한쪽 경로만 발화해도 기존 `child.on('exit')` 핸들러가 나머지를 정리하는 이중 안전망.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun run build`), `@modelcontextprotocol/sdk` StdioServerTransport, Node `child_process.spawn`.

---

### Task 1: 자식 서버 stdin EOF 종료 + 통합 테스트

**Files:**
- Modify: `src/mcp/server.ts:93-98` (`main()` 함수)
- Test: `src/mcp/server.lifecycle.test.ts` (Create)

본 변경은 프로세스 lifecycle이라 기존 `server.test.ts`의 schema 단위 테스트로는 검증할 수 없다. 실제 빌드된 서버 번들을 spawn하고 stdin을 닫아 종료를 확인하는 통합 테스트를 새 파일로 작성한다. 테스트는 `dist/mcp-server.mjs`가 존재해야 하므로 빌드 의존성이 있다.

- [ ] **Step 1: 빌드해서 현재 번들을 최신화**

Run: `bun run build`
Expected: `dist/mcp-server.mjs`, `dist/cli-internal.mjs`, `bin/memmem` 재생성 (에러 없이 종료).

- [ ] **Step 2: 실패하는 통합 테스트 작성**

Create `src/mcp/server.lifecycle.test.ts`:

```ts
/**
 * MCP server process lifecycle tests.
 *
 * Verifies the server exits on its own when stdin closes (client/parent gone),
 * preventing orphaned processes after an abnormal claude shutdown.
 */
import { describe, test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const SERVER = join(import.meta.dir, '..', '..', 'dist', 'mcp-server.mjs');

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not exit within ${timeoutMs}ms after stdin close`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('MCP server process lifecycle', () => {
  test('exits cleanly when stdin closes', async () => {
    const child = spawn('bun', [SERVER], { stdio: ['pipe', 'ignore', 'ignore'] });
    // Give the server a moment to connect its transport, then close stdin (EOF).
    await new Promise((r) => setTimeout(r, 500));
    child.stdin!.end();
    const code = await waitForExit(child, 5000);
    expect(code).toBe(0);
  }, 10000);
});
```

- [ ] **Step 3: 테스트 실행해 실패 확인**

Run: `bun test src/mcp/server.lifecycle.test.ts`
Expected: FAIL — "server did not exit within 5000ms after stdin close" (현재 코드는 stdin close에 반응하지 않으므로 종료되지 않음).

- [ ] **Step 4: 최소 구현 — `main()`에 stdin close 핸들러 추가**

`src/mcp/server.ts`의 `main()` 함수(line 93-98)를 다음으로 변경:

```ts
async function main() {
  console.error('Conversation Memory MCP server running via stdio');

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 클라이언트(부모 claude)가 stdin을 닫으면 더 받을 요청이 없으므로 종료한다.
  // claude 크래시/강제 종료 시 서버가 고아로 남는 것을 방지.
  process.stdin.on('close', () => process.exit(0));
}
```

- [ ] **Step 5: 재빌드 후 테스트 통과 확인**

Run: `bun run build && bun test src/mcp/server.lifecycle.test.ts`
Expected: PASS (서버가 stdin close 후 5초 안에 code 0으로 종료).

- [ ] **Step 6: 기존 MCP 테스트 회귀 없음 확인**

Run: `bun test src/mcp/`
Expected: 전부 PASS (schema/handler 테스트 영향 없음).

- [ ] **Step 7: 커밋**

```bash
git add src/mcp/server.ts src/mcp/server.lifecycle.test.ts dist/mcp-server.mjs dist/cli-internal.mjs bin/memmem
git commit -m "fix(mcp): 자식 서버 stdin EOF 시 종료해 고아 방지"
```

---

### Task 2: 부모 래퍼 stdin EOF 시 자식 정리

**Files:**
- Modify: `src/cli/mcp.ts:60-70` (`runMcpCli()`의 spawn 이후 핸들러 등록부)

부모(`memmem mcp`)는 `stdio: 'inherit'`로 자식과 stdin을 공유한다. 부모도 stdin close를 감지해 자식을 정리한다. 부모 쪽 `'close'`가 inherit 구조에서 발화하지 않을 수 있는데, 그 경우 Task 1의 자식 종료 → 기존 `child.on('exit')`(line 63-66)가 부모를 종료시키므로 안전망이 성립한다. 이 Task는 그 반대 방향(부모가 먼저 EOF를 보는 경우)을 보강한다.

- [ ] **Step 1: 부모에 stdin close 핸들러 추가**

`src/cli/mcp.ts`의 line 61-62(SIGTERM/SIGINT 핸들러) 바로 아래에 추가:

```ts
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
  // 부모(claude)가 stdin을 닫으면 자식 서버를 정리하고 함께 종료한다.
  process.stdin.on('close', () => child.kill('SIGTERM'));
```

- [ ] **Step 2: 재빌드**

Run: `bun run build`
Expected: 번들 재생성 (에러 없음).

- [ ] **Step 3: 부모 래퍼 수동 통합 검증**

`bin/memmem mcp`를 stdin 파이프로 띄우고 stdin을 닫았을 때 부모·자식이 모두 사라지는지 확인:

```bash
bun bin/memmem mcp < /dev/null &
PARENT=$!
sleep 2
ps -eo pid,ppid,command | grep -E "memmem mcp|mcp-server.mjs" | grep -v grep
sleep 2
echo "--- after stdin EOF (/dev/null closes immediately) ---"
ps -eo pid,ppid,command | grep -E "memmem mcp|mcp-server.mjs" | grep -v grep || echo "all gone"
```

Expected: 두 번째 `ps`에서 `memmem mcp` / `mcp-server.mjs` 프로세스가 남아있지 않음 ("all gone"). `< /dev/null`은 stdin이 즉시 EOF이므로 빠르게 정리되어야 한다.

(참고: 이 검증이 환경 의존적이면 Task 1의 자식 종료 경로가 1차 안전망이므로, 부모 핸들러는 보강으로 남기고 결과를 커밋 메시지에 기록한다.)

- [ ] **Step 4: 전체 테스트 회귀 없음 확인**

Run: `bun test`
Expected: 전부 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/cli/mcp.ts dist/cli-internal.mjs dist/mcp-server.mjs bin/memmem
git commit -m "fix(mcp): 부모 래퍼 stdin EOF 시 자식 정리"
```

---

### Task 3: 타입체크 + 최종 검증

**Files:** 없음 (검증만)

- [ ] **Step 1: 타입체크**

Run: `bun run typecheck`
Expected: 에러 없음 (`tsc --noEmit` 통과).

- [ ] **Step 2: 전체 테스트**

Run: `bun test`
Expected: 전부 PASS.

- [ ] **Step 3: 빌드 산출물이 커밋되었는지 확인**

Run: `git status --porcelain dist/ bin/`
Expected: 출력 없음 (dist/bin이 깨끗 = 빌드 산출물이 커밋됨). marketplace SessionStart 훅이 커밋된 빌드를 요구하므로 필수.

---

## Self-Review 결과

**Spec coverage:**
- 변경 1 (자식 server.ts stdin close) → Task 1 ✓
- 변경 2 (부모 mcp.ts stdin close) → Task 2 ✓
- 테스트 전략 (통합 테스트, 기존 컨벤션) → Task 1 통합 테스트, Task 2 수동 검증 ✓
- 범위 밖 (ppid 폴링 등) → 계획에 미포함 ✓
- 빌드 산출물 재커밋 (marketplace 훅) → 각 커밋에 dist/bin 포함 + Task 3 Step 3 확인 ✓

**Placeholder scan:** 모든 코드 스텝에 실제 코드 포함. "TBD"/"TODO" 없음. ✓

**Type consistency:** `process.stdin.on('close', ...)`, `child.kill('SIGTERM')`, `process.exit(0)` — 모든 Task에서 동일 시그니처 사용. `child`는 `src/cli/mcp.ts:60`의 spawn 반환값으로 기존 코드와 일치. ✓
