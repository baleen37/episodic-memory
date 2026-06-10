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
