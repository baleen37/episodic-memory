import { describe, test, expect, beforeEach } from 'bun:test';
import {
  getQueryNormalizerProvider,
  resetQueryNormalizerCache,
  type QueryNormalizerConfig
} from './handlers.js';

describe('query-normalizer', () => {
  beforeEach(() => {
    resetQueryNormalizerCache();
  });

  describe('resetQueryNormalizerCache', () => {
    test('resets cached provider', async () => {
      const config: QueryNormalizerConfig = {
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        apiKey: 'test-key'
      };

      // First call creates provider
      const provider1 = await getQueryNormalizerProvider(
        () => config,
        async () => ({ complete: async () => '' }) as any
      );

      // Second call returns cached provider
      const provider2 = await getQueryNormalizerProvider(
        () => config,
        async () => ({ complete: async () => '' }) as any
      );

      expect(provider1).toBe(provider2);

      // Reset and create again
      resetQueryNormalizerCache();
      const provider3 = await getQueryNormalizerProvider(
        () => config,
        async () => ({ complete: async () => '' }) as any
      );

      expect(provider3).not.toBe(provider1);
    });

    test('returns undefined when config is missing', async () => {
      const provider = await getQueryNormalizerProvider(
        () => null,
        async () => ({ complete: async () => '' }) as any
      );

      expect(provider).toBeUndefined();
    });

    test('returns undefined when provider creation fails', async () => {
      const config: QueryNormalizerConfig = {
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        apiKey: 'bad-key'
      };

      const provider = await getQueryNormalizerProvider(
        () => config,
        async () => { throw new Error('API error'); }
      );

      expect(provider).toBeUndefined();
    });
  });
});
