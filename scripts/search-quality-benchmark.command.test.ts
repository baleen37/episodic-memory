import { expect, test } from 'bun:test';
import { $ } from 'bun';

async function runBenchmarkCommand(env: Record<string, string | undefined>): Promise<string> {
  // bun test's custom SQLite preload belongs to the parent worker; apply the
  // same runtime setup to the child so sqlite-vec can load its extension.
  const command = await $`${process.execPath} --preload ./scripts/preload-sqlite.ts run bench:search-quality`
    .cwd(new URL('..', import.meta.url).pathname)
    .env({ ...process.env, ...env })
    .quiet();
  if (command.exitCode !== 0) {
    throw new Error(`benchmark command failed with exit ${command.exitCode}: ${command.stderr.toString().slice(-4000)}`);
  }
  return command.stdout.toString();
}

test('benchmark is deterministic when embeddings are disabled in the command environment', async () => {
  const normal = await runBenchmarkCommand({ MEMMEM_DISABLE_EMBEDDINGS: undefined });
  const disabled = await runBenchmarkCommand({ MEMMEM_DISABLE_EMBEDDINGS: 'true' });
  const stableMetrics = (output: string) => output
    .match(/^METRIC (ndcg_at_10|recall_at_5|mrr_at_10|empty_rate)=.*$/gm);
  const normalMetrics = stableMetrics(normal);
  const disabledMetrics = stableMetrics(disabled);
  expect(normalMetrics).toHaveLength(4);
  expect(disabledMetrics).toEqual(normalMetrics);
}, 120_000);
