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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
      expect(names).toContain('fetch');
    } finally {
      await client?.close();
      cleanup(tmpHome);
    }
  }, 30_000);
});
