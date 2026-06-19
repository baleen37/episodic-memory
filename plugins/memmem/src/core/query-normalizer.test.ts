import { describe, expect, test } from 'bun:test';
import { resolveQueryNormalizer } from './query-normalizer.js';
import type { LLMConfig } from './llm/config.js';
import type { LLMProvider } from './llm/types.js';

describe('resolveQueryNormalizer', () => {
  const fakeProvider: LLMProvider = {
    complete: async () => ({ text: 'x', usage: { input_tokens: 0, output_tokens: 0 } }),
  };

  test('returns undefined when no LLM is configured', async () => {
    const normalizer = await resolveQueryNormalizer({
      loadConfig: () => null,
      createProvider: async () => fakeProvider,
    });
    expect(normalizer).toBeUndefined();
  });

  test('returns the created provider when LLM is configured', async () => {
    const config: LLMConfig = { provider: 'gemini', apiKey: 'k', model: 'm' };
    const normalizer = await resolveQueryNormalizer({
      loadConfig: () => config,
      createProvider: async (c) => {
        expect(c).toBe(config);
        return fakeProvider;
      },
    });
    expect(normalizer).toBe(fakeProvider);
  });

  test('returns undefined when provider creation fails', async () => {
    const normalizer = await resolveQueryNormalizer({
      loadConfig: () => ({ provider: 'gemini', apiKey: 'k' }),
      createProvider: async () => {
        throw new Error('boom');
      },
    });
    expect(normalizer).toBeUndefined();
  });
});
