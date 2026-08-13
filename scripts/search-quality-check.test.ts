import { describe, expect, test } from 'bun:test';

const gateTest = process.env.SEARCH_QUALITY_CHECK_RUNNING === '1' ? test.skip : test;

describe('search quality correctness gate', () => {
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
