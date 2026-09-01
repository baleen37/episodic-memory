import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  checkDependencies,
  installDependencies,
  analyzeError,
} from '../../scripts/lib/check-dependencies.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Walk up from `start` until a directory containing package.json is found. */
function findRoot(start: string): string {
  let dir = start;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return start;
}

const PLUGIN_ROOT = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || findRoot(__dirname);

// 시작 시 빌드를 트리거하지 않는다. 빌드는 수 초가 걸려 MCP stdio 핸드셰이크를
// 막고 시작 타임아웃을 유발한다. 배포본은 dist/가 이미 빌드되어 있으며, 누락 시
// runMcpCli가 친절한 에러를 낸다(아래). 로컬 소스 개발 시엔 `bun run build` 사용.
export async function ensureDependencies(): Promise<void> {
  const { installed } = checkDependencies();
  if (!installed) {
    console.error('[episodic-memory] Installing dependencies (first run only)...');
    await installDependencies(false);
  }
}

export async function runMcpCli(): Promise<void> {
  try {
    await ensureDependencies();
  } catch (error) {
    const analysis = analyzeError(error as Error);
    console.error('[episodic-memory] ERROR: setup failed.');
    console.error(`Cause: ${analysis.cause}`);
    console.error(`Fix: ${analysis.fix}`);
    process.exit(1);
  }

  const mcpServerPath = join(PLUGIN_ROOT, 'dist', 'mcp-server.mjs');
  if (!existsSync(mcpServerPath)) {
    console.error(`[episodic-memory] ERROR: MCP server not found at ${mcpServerPath}`);
    console.error('Please run: bun run build');
    process.exit(1);
  }

  // bun:sqlite를 import하므로 반드시 bun으로 spawn.
  const child = spawn('bun', [mcpServerPath], { stdio: 'inherit', shell: false });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
  // 부모(claude)가 stdin을 닫으면 자식 서버를 정리하고 함께 종료한다.
  process.stdin.on('close', () => child.kill('SIGTERM'));
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error(`[episodic-memory] ERROR: Failed to start MCP server: ${err.message}`);
    process.exit(1);
  });
}
