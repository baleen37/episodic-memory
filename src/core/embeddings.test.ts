import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import net from 'net';
import EventEmitter from 'events';
import { EMBEDDING_DIM } from './constants.js';

// Don't mock child_process spawn — the connector mock prevents actual spawning

describe('isEmbeddingsDisabled()', () => {
  test('returns false by default', async () => {
    const { isEmbeddingsDisabled } = await import('./embeddings.js');
    expect(isEmbeddingsDisabled()).toBe(false);
  });

  test('returns true when MEMMEM_DISABLE_EMBEDDINGS=true', async () => {
    // Note: Module reset not needed in bun:test - mock.module is hoisted
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    const { isEmbeddingsDisabled } = await import('./embeddings.js');
    expect(isEmbeddingsDisabled()).toBe(true);
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
  });
});

describe('generateEmbedding()', () => {
  // Note: In bun:test, mock.module is hoisted and doesn't need resetModules

  beforeEach(async () => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    const { __setWorkerConnectorForTests } = await import('./embeddings.js');
    __setWorkerConnectorForTests(null);
  });

  afterEach(async () => {
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
    const { __setWorkerConnectorForTests } = await import('./embeddings.js');
    __setWorkerConnectorForTests(null);
  });

  test('returns null when MEMMEM_DISABLE_EMBEDDINGS=true', async () => {
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';
    const { generateEmbedding } = await import('./embeddings.js');
    expect(await generateEmbedding('test')).toBeNull();
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
  });

  test('sends request to worker and returns embedding', async () => {
    const mockEmbedding = Array.from({ length: EMBEDDING_DIM }, (_, i) => i * 0.001);
    const { generateEmbedding, __setWorkerConnectorForTests } = await import('./embeddings.js');
    __setWorkerConnectorForTests(() => Promise.resolve(createMockSocket({ embedding: mockEmbedding })));

    const result = await generateEmbedding('hello world');
    expect(result).toEqual(mockEmbedding);
    __setWorkerConnectorForTests(null);
  });

  test('returns null when worker connection fails', async () => {
    const { generateEmbedding, __setWorkerConnectorForTests } = await import('./embeddings.js');
    __setWorkerConnectorForTests(() => Promise.reject(new Error('ENOENT')));

    const result = await generateEmbedding('hello');
    expect(result).toBeNull();
    __setWorkerConnectorForTests(null);
  });

  test('returns null when worker returns error response', async () => {
    const { generateEmbedding, __setWorkerConnectorForTests } = await import('./embeddings.js');
    __setWorkerConnectorForTests(() => Promise.resolve(createMockSocket({ error: 'model failed' })));

    const result = await generateEmbedding('hello');
    expect(result).toBeNull();
    __setWorkerConnectorForTests(null);
  });

  test('handles concurrent requests with correct id matching', async () => {
    const { generateEmbedding, __setWorkerConnectorForTests } = await import('./embeddings.js');
    const mockSocket = createMockSocketMulti();
    __setWorkerConnectorForTests(() => Promise.resolve(mockSocket));

    const results = await Promise.all([
      generateEmbedding('text 1'),
      generateEmbedding('text 2'),
      generateEmbedding('text 3'),
    ]);

    expect(results).toHaveLength(3);
    results.forEach(r => expect(r).toHaveLength(EMBEDDING_DIM));
    __setWorkerConnectorForTests(null);
  });
});

// Mock socket helpers
function createMockSocket(response: object): net.Socket {
  const emitter = new EventEmitter() as any;
  emitter.write = (data: any) => {
    const req = JSON.parse(data.toString().trim());
    setImmediate(() => emitter.emit('data', JSON.stringify({ id: req.id, ...response }) + '\n'));
    return true;
  };
  emitter.destroyed = false;
  emitter.destroy = () => { emitter.destroyed = true; return emitter; };
  emitter.end = () => emitter;
  return emitter as net.Socket;
}

function createMockSocketMulti(): net.Socket {
  const emitter = new EventEmitter() as any;
  emitter.write = (data: any) => {
    const req = JSON.parse(data.toString().trim());
    const embedding = Array.from({ length: EMBEDDING_DIM }, () => Math.random());
    setImmediate(() => emitter.emit('data', JSON.stringify({ id: req.id, embedding }) + '\n'));
    return true;
  };
  emitter.destroyed = false;
  emitter.destroy = () => { emitter.destroyed = true; return emitter; };
  emitter.end = () => emitter;
  return emitter as net.Socket;
}
