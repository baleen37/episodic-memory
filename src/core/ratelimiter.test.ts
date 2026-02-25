/**
 * Ratelimiter Tests
 *
 * Tests for the global rate limiter module using token bucket algorithm.
 */

import { describe, test, expect, beforeEach, afterEach, mock, setSystemTime } from 'bun:test';
import { RateLimiter, getEmbeddingRateLimiter, getLLMRateLimiter, resetRateLimiters, __setLoadConfigForTests } from './ratelimiter.js';

// Mock config return value (injected via __setLoadConfigForTests)
let mockConfigReturnValue: { ratelimit?: { embedding?: { requestsPerSecond?: number; burstSize?: number }; llm?: { requestsPerSecond?: number; burstSize?: number } } } | null = null;

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    setSystemTime(0);
    limiter = new RateLimiter({ requestsPerSecond: 2, burstSize: 2 });
  });

  afterEach(() => {
    setSystemTime();
  });

  describe('Token Bucket Algorithm', () => {
    test('allows requests within burst size immediately', async () => {
      const promise1 = limiter.acquire();
      const promise2 = limiter.acquire();

      await promise1;
      await promise2;
    });

    test('delays requests exceeding burst size', async () => {
      await limiter.acquire();
      await limiter.acquire();

      const promise3 = limiter.acquire();
      const spy = mock();
      promise3.then(spy);

      expect(spy).not.toHaveBeenCalled();

      setSystemTime(500);
      await Bun.sleep(510);

      expect(spy).toHaveBeenCalled();
    });

    test('tokens refill over time', async () => {
      await limiter.acquire();
      await limiter.acquire();

      setSystemTime(1000);
      await Bun.sleep(0);

      const promise1 = limiter.acquire();
      const promise2 = limiter.acquire();

      await promise1;
      await promise2;
    });

    test('tokens do not exceed burst size', async () => {
      await limiter.acquire();

      setSystemTime(10000);
      await Bun.sleep(0);

      await limiter.acquire();
      await limiter.acquire();

      const promise3 = limiter.acquire();
      const spy = mock();
      promise3.then(spy);

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('Configuration', () => {
    test('uses default values when not specified', () => {
      const defaultLimiter = new RateLimiter();
      expect(defaultLimiter.getAvailableTokens()).toBe(1);
    });

    test('accepts custom configuration', () => {
      const customLimiter = new RateLimiter({ requestsPerSecond: 10, burstSize: 5 });
      expect(customLimiter.getAvailableTokens()).toBe(5);
    });

    test('burst size defaults to 1 when not specified', () => {
      const limiter = new RateLimiter({ requestsPerSecond: 3 });
      expect(limiter.getAvailableTokens()).toBe(1);
    });
  });

  describe('tryAcquire', () => {
    test('returns true when tokens available', () => {
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
    });

    test('returns false when no tokens available', () => {
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.tryAcquire()).toBe(false);
    });

    test('does not queue request on failure', () => {
      limiter.tryAcquire();
      limiter.tryAcquire();
      expect(limiter.tryAcquire()).toBe(false);
      expect(limiter.tryAcquire()).toBe(false);
    });
  });

  describe('getAvailableTokens', () => {
    test('returns current token count', async () => {
      expect(limiter.getAvailableTokens()).toBe(2);

      await limiter.acquire();
      expect(limiter.getAvailableTokens()).toBe(1);

      await limiter.acquire();
      expect(limiter.getAvailableTokens()).toBe(0);
    });

    test('reflects token refill over time', async () => {
      await limiter.acquire();
      await limiter.acquire();
      expect(limiter.getAvailableTokens()).toBe(0);

      setSystemTime(500);
      await Bun.sleep(0);

      expect(limiter.getAvailableTokens()).toBe(1);
    });
  });
});

describe('Factory Functions', () => {
  beforeEach(() => {
    resetRateLimiters();
    mockConfigReturnValue = null;
    __setLoadConfigForTests(() => mockConfigReturnValue as any);
  });

  afterEach(() => {
    __setLoadConfigForTests(null);
    setSystemTime();
  });

  test('getEmbeddingRateLimiter returns singleton', () => {
    const limiter1 = getEmbeddingRateLimiter();
    const limiter2 = getEmbeddingRateLimiter();

    expect(limiter1).toBe(limiter2);
  });

  test('getLLMRateLimiter returns singleton', () => {
    const limiter1 = getLLMRateLimiter();
    const limiter2 = getLLMRateLimiter();

    expect(limiter1).toBe(limiter2);
  });

  test('embedding and LLM limiters are separate instances', () => {
    const embeddingLimiter = getEmbeddingRateLimiter();
    const llmLimiter = getLLMRateLimiter();

    expect(embeddingLimiter).not.toBe(llmLimiter);
  });
});

describe('Config Integration', () => {
  beforeEach(() => {
    resetRateLimiters();
    mockConfigReturnValue = null;
    __setLoadConfigForTests(() => mockConfigReturnValue as any);
  });

  afterEach(() => {
    __setLoadConfigForTests(null);
    setSystemTime();
  });

  test('getEmbeddingRateLimiter uses default values when no config', () => {
    mockConfigReturnValue = null;
    const limiter = getEmbeddingRateLimiter();
    expect(limiter.getAvailableTokens()).toBe(1);
  });

  test('getEmbeddingRateLimiter uses config values when available', () => {
    mockConfigReturnValue = {
      ratelimit: {
        embedding: { requestsPerSecond: 10, burstSize: 25 },
      },
    };
    const limiter = getEmbeddingRateLimiter();
    expect(limiter.getAvailableTokens()).toBe(25);
  });

  test('getLLMRateLimiter uses default values when no config', () => {
    mockConfigReturnValue = null;
    const limiter = getLLMRateLimiter();
    expect(limiter.getAvailableTokens()).toBe(1);
  });

  test('getLLMRateLimiter uses config values when available', () => {
    mockConfigReturnValue = {
      ratelimit: {
        llm: { requestsPerSecond: 5, burstSize: 15 },
      },
    };
    const limiter = getLLMRateLimiter();
    expect(limiter.getAvailableTokens()).toBe(15);
  });

  test('getEmbeddingRateLimiter uses default burst when only rps specified', () => {
    mockConfigReturnValue = {
      ratelimit: {
        embedding: { requestsPerSecond: 8 },
      },
    };
    const limiter = getEmbeddingRateLimiter();
    expect(limiter.getAvailableTokens()).toBe(1);
  });

  test('getLLMRateLimiter uses default burst when only rps specified', () => {
    mockConfigReturnValue = {
      ratelimit: {
        llm: { requestsPerSecond: 3 },
      },
    };
    const limiter = getLLMRateLimiter();
    expect(limiter.getAvailableTokens()).toBe(1);
  });

  test('both limiters use separate config values', () => {
    mockConfigReturnValue = {
      ratelimit: {
        embedding: { requestsPerSecond: 10, burstSize: 30 },
        llm: { requestsPerSecond: 1, burstSize: 2 },
      },
    };
    const embLimiter = getEmbeddingRateLimiter();
    const llmLimiter = getLLMRateLimiter();
    expect(embLimiter.getAvailableTokens()).toBe(30);
    expect(llmLimiter.getAvailableTokens()).toBe(2);
  });
});

describe('Integration Scenarios', () => {
  beforeEach(() => {
    setSystemTime(0);
  });

  afterEach(() => {
    setSystemTime();
  });

  test('handles rapid consecutive requests', async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 5, burstSize: 3 });

    const promises = [
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
    ];

    const results = await Promise.all([
      promises[0].then(() => 'done1'),
      promises[1].then(() => 'done2'),
      promises[2].then(() => 'done3'),
    ]);

    expect(results).toEqual(['done1', 'done2', 'done3']);

    setSystemTime(1000);
    await Bun.sleep(210);

    const remaining = await Promise.all([
      promises[3].then(() => 'done4'),
      promises[4].then(() => 'done5'),
    ]);

    expect(remaining).toEqual(['done4', 'done5']);
  });

  test('respects rate limit over extended period', async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 2, burstSize: 2 });

    const timestamps: number[] = [];

    for (let i = 0; i < 5; i++) {
      limiter.acquire().then(() => {
        timestamps.push(Date.now());
      });
    }

    await Promise.resolve();

    setSystemTime(500);
    await Bun.sleep(510);
    setSystemTime(1000);
    await Bun.sleep(510);
    setSystemTime(1500);
    await Bun.sleep(510);

    expect(timestamps).toHaveLength(5);

    expect(timestamps[0]).toBe(0);
    expect(timestamps[1]).toBe(0);
    expect(timestamps[2]).toBeGreaterThanOrEqual(500);
    expect(timestamps[3]).toBeGreaterThanOrEqual(1000);
    expect(timestamps[4]).toBeGreaterThanOrEqual(1500);
  });
});
