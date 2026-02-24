import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { EMBEDDING_DIM } from '../core/constants.js';

// Mock embeddings-model (no real model loading)
vi.mock('../core/embeddings-model.js', () => ({
  initModel: vi.fn().mockResolvedValue(undefined),
  generateEmbeddingFromModel: vi.fn().mockResolvedValue(Array.from({ length: EMBEDDING_DIM }, (_, i) => i * 0.001)),
}));

// Mock ratelimiter
vi.mock('../core/ratelimiter.js', () => ({
  getEmbeddingRateLimiter: () => ({ acquire: vi.fn().mockResolvedValue(undefined) }),
}));

import { startWorker, getSocketPath } from './embedding-worker.js';

describe('getSocketPath()', () => {
  test('returns path under ~/.config/memmem/', () => {
    const p = getSocketPath();
    expect(p).toContain('.config/memmem');
    expect(p.endsWith('embedding-worker.sock')).toBe(true);
  });

  test('respects CONVERSATION_MEMORY_CONFIG_DIR', () => {
    process.env.CONVERSATION_MEMORY_CONFIG_DIR = '/tmp/test-memmem-worker';
    expect(getSocketPath()).toBe('/tmp/test-memmem-worker/embedding-worker.sock');
    delete process.env.CONVERSATION_MEMORY_CONFIG_DIR;
  });
});

describe('startWorker()', () => {
  const sockPath = path.join(os.tmpdir(), `memmem-worker-test-${process.pid}.sock`);
  let server: net.Server;

  beforeAll(async () => {
    server = await startWorker(sockPath) as net.Server;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => {
      server?.close(() => {
        if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
        resolve();
      });
    });
  });

  test('returns net.Server when started fresh', () => {
    expect(server).toBeDefined();
    expect(server.listening).toBe(true);
  });

  test('handles embedding request and returns correct-dim vector', async () => {
    const resp = await sendRequest(sockPath, { id: 'req-1', text: 'hello world' });
    expect(resp.id).toBe('req-1');
    expect(resp.embedding).toHaveLength(EMBEDDING_DIM);
    expect(resp.error).toBeUndefined();
  });

  test('handles concurrent requests from same connection', async () => {
    const requests = Array.from({ length: 5 }, (_, i) =>
      sendRequest(sockPath, { id: `c-${i}`, text: `text ${i}` })
    );
    const responses = await Promise.all(requests);
    const ids = new Set(responses.map(r => r.id));
    expect(ids.size).toBe(5);
    responses.forEach(r => expect(r.embedding).toHaveLength(EMBEDDING_DIM));
  });

  test('returns error when generateEmbeddingFromModel returns null', async () => {
    const { generateEmbeddingFromModel } = await import('../core/embeddings-model.js');
    vi.mocked(generateEmbeddingFromModel).mockResolvedValueOnce(null);
    const resp = await sendRequest(sockPath, { id: 'null-test', text: 'fail' });
    expect(resp.error).toBe('embedding returned null');
    expect(resp.embedding).toBeUndefined();
  });

  test('handles malformed JSON with error response', async () => {
    const resp = await sendRaw(sockPath, 'not json\n');
    expect(resp.error).toBeDefined();
  });

  test('returns null when socket already alive (duplicate detection)', async () => {
    const result = await startWorker(sockPath);
    expect(result).toBeNull();
  });
});

// Helpers
async function sendRequest(sockPath: string, req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(sockPath);
    let buf = '';
    client.on('connect', () => client.write(JSON.stringify(req) + '\n'));
    client.on('data', chunk => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) { client.destroy(); resolve(JSON.parse(buf.slice(0, nl))); }
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
}

async function sendRaw(sockPath: string, raw: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(sockPath);
    let buf = '';
    client.on('connect', () => client.write(raw));
    client.on('data', chunk => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) { client.destroy(); resolve(JSON.parse(buf.slice(0, nl))); }
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
}
