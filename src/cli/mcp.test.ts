import { test, expect, mock, afterEach } from 'bun:test';

// MCP 시작 경로는 동기 빌드를 트리거하면 안 된다. 빌드는 수 초가 걸려
// MCP stdio 핸드셰이크를 막고 Claude Code 시작 타임아웃(failed)을 유발한다.
// 배포본은 dist/가 이미 빌드되어 있으므로 시작 시 빌드가 불필요하다.

afterEach(() => {
  mock.restore();
});

test('ensureDependencies는 시작 시 빌드를 트리거하지 않는다', async () => {
  let buildCalled = false;
  let buildCheckCalled = false;

  mock.module('../../scripts/lib/check-dependencies.mjs', () => ({
    checkDependencies: () => ({ installed: true, missing: [] }),
    installDependencies: async () => {},
    checkBuildNeeded: () => {
      buildCheckCalled = true;
      return { needsBuild: true, reason: 'package.json newer than dist' };
    },
    runBuild: async () => {
      buildCalled = true;
    },
    analyzeError: (e: Error) => ({ cause: e.message, fix: '' }),
  }));

  const { ensureDependencies } = await import('./mcp.js');
  await ensureDependencies();

  expect(buildCalled).toBe(false);
  expect(buildCheckCalled).toBe(false);
});
