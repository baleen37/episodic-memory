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
