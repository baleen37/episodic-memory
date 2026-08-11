/**
 * Bounds how many async operations run concurrently.
 *
 * Used for in-process embedding: the work is CPU-bound and cheap per call
 * (~12.6ms), so a requests-per-second limit only adds latency. What actually
 * needs bounding is simultaneous inference across callers (several MCP servers
 * can embed at once, and ONNX runtime is itself multi-threaded per call).
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.available = Math.max(1, Math.floor(maxConcurrent));
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }
}

/** Runs `fn` holding one slot, releasing it even if `fn` throws. */
export async function withSemaphore<T>(sem: Semaphore, fn: () => Promise<T>): Promise<T> {
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
  }
}
