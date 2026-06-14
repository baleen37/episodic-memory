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
