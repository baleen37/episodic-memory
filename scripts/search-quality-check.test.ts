import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const testFile = new URL('./search-quality-check.test.ts', import.meta.url).pathname;

function isDirectGateTestInvocation(commandLine: string): boolean {
  return commandLine.includes('bun test') && commandLine.split(/\s+/).some((arg) => (
    resolve(arg.replace(/^["']|["']$/g, '')) === testFile
  ));
}

const parent = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(process.ppid)]);
const gateTest = process.env.SEARCH_QUALITY_CHECK_RUNNING === '1'
  || !isDirectGateTestInvocation(parent.stdout.toString())
  ? test.skip
  : test;

describe('search quality correctness gate', () => {
  test('detects an explicitly selected gate test file', () => {
    expect(isDirectGateTestInvocation('bun test scripts/search-quality-check.test.ts')).toBe(true);
    expect(isDirectGateTestInvocation(`bun test ${testFile}`)).toBe(true);
    expect(isDirectGateTestInvocation('bun test')).toBe(false);
  });

  gateTest('runs the benchmark, tests, typecheck, and build checks', async () => {
    const script = new URL('./search-quality-check.sh', import.meta.url).pathname;
    const process = Bun.spawn(['bash', script], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'ignore',
    });

    const stdout = await new Response(process.stdout).text();

    expect(await process.exited).toBe(0);
    expect(stdout).toContain('benchmark');
    expect(stdout).toContain('tests');
    expect(stdout).toContain('typecheck');
    expect(stdout).toContain('build');
  }, 120_000);
});
