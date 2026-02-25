import { describe, test, expect, beforeEach } from 'bun:test';
import {
  getNormalizerProvider,
  resetNormalizerCache,
  type NormalizerConfig
} from './normalizer.js';

describe('query-normalizer', () => {
  beforeEach(() => {
    resetNormalizerCache();
  });

  describe('resetNormalizerCache', () => {
    test('resets cached provider', async () => {
      const config: NormalizerConfig = {
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        apiKey: 'test-key'
      };

      // First call creates provider
      const provider1 = await getNormalizerProvider(
        () => config,
        async () => ({ complete: async () => '' }) as any
      );

      // Second call returns cached provider
      const provider2 = await getNormalizerProvider(
        () => config,
        async () => ({ complete: async () => '' }) as any
      );

      expect(provider1).toBe(provider2);

      // Reset and create again
      resetNormalizerCache();
      const provider3 = await getNormalizerProvider(
        () => config,
        async () => ({ complete: async () => '' }) as any
      );

      expect(provider3).not.toBe(provider1);
    });

    test('returns undefined when config is missing', async () => {
      const provider = await getNormalizerProvider(
        () => null,
        async () => ({ complete: async () => '' }) as any
      );

      expect(provider).toBeUndefined();
    });

    test('returns undefined when provider creation fails', async () => {
      const config: NormalizerConfig = {
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        apiKey: 'bad-key'
      };

      const provider = await getNormalizerProvider(
        () => config,
        async () => { throw new Error('API error'); }
      );

      expect(provider).toBeUndefined();
    });
  });
});
