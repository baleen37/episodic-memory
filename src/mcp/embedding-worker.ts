import net from 'net';
import path from 'path';
import fs from 'fs';
import { initModel, generateEmbeddingFromModel } from '../core/embeddings-model.js';
import { getEmbeddingRateLimiter } from '../core/ratelimiter.js';
import { getSuperpowersDir } from '../core/paths.js';

const IDLE_TIMEOUT_MS = 60_000;

export function getSocketPath(): string {
  return path.join(getSuperpowersDir(), 'embedding-worker.sock');
}

function isSocketAlive(sockPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const client = net.createConnection(sockPath);
    client.once('connect', () => { client.destroy(); resolve(true); });
    client.once('error', () => resolve(false));
    setTimeout(() => { client.destroy(); resolve(false); }, 500);
  });
}

export async function startWorker(sockPath: string): Promise<net.Server | null> {
  if (await isSocketAlive(sockPath)) return null;

  if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });

  await initModel();

  let activeConnections = 0;
  let idleTimer: NodeJS.Timeout | null = null;

  function resetIdleTimer(server: net.Server) {
    if (idleTimer) clearTimeout(idleTimer);
    if (activeConnections === 0) {
      idleTimer = setTimeout(() => {
        server.close();
        if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
        process.exit(0);
      }, IDLE_TIMEOUT_MS);
    }
  }

  const server = net.createServer(socket => {
    activeConnections++;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

    let buffer = '';

    socket.on('data', async chunk => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let reqId = 'unknown';
        try {
          const req = JSON.parse(line);
          reqId = req.id ?? 'unknown';
          if (!req.id || typeof req.text !== 'string') throw new Error('invalid request');

          await getEmbeddingRateLimiter().acquire();
          const embedding = await generateEmbeddingFromModel(req.text);
          const resp = embedding
            ? { id: req.id, embedding }
            : { id: req.id, error: 'embedding returned null' };
          socket.write(JSON.stringify(resp) + '\n');
        } catch (err) {
          socket.write(JSON.stringify({
            id: reqId,
            error: err instanceof Error ? err.message : String(err),
          }) + '\n');
        }
      }
    });

    const cleanup = () => {
      activeConnections = Math.max(0, activeConnections - 1);
      resetIdleTimer(server);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  return new Promise((resolve, reject) => {
    server.listen(sockPath, () => {
      resetIdleTimer(server);
      resolve(server);
    });
    server.once('error', reject);
  });
}

// Entrypoint guard (same pattern as mcp/server.ts)
function shouldRunAsEntrypoint(): boolean {
  return process.env.VITEST !== 'true' && !(import.meta as ImportMeta & { test?: boolean }).test;
}

if (shouldRunAsEntrypoint()) {
  const sockPath = getSocketPath();
  startWorker(sockPath)
    .then(server => {
      if (server === null) process.exit(0); // duplicate
      process.stdin.unref?.();
    })
    .catch(err => {
      console.error('embedding-worker startup failed:', err);
      process.exit(1);
    });
}
