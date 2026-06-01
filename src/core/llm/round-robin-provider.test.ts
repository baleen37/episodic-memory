import { describe, it, expect, mock } from 'bun:test';
import { RoundRobinProvider } from './round-robin-provider.js';
import type { LLMProvider, LLMResult } from './types.js';

const ok = (text: string): LLMResult => ({
  text,
  usage: { input_tokens: 1, output_tokens: 1 },
});

function stubProvider(label: string, impl?: () => Promise<LLMResult>): LLMProvider {
  return {
    complete: mock(impl ?? (async () => ok(label))),
  } as unknown as LLMProvider;
}

describe('RoundRobinProvider', () => {
  it('rotates to the next provider on each successful call', async () => {
    const a = stubProvider('A');
    const b = stubProvider('B');
    const rr = new RoundRobinProvider([a, b]);

    expect((await rr.complete('p')).text).toBe('A');
    expect((await rr.complete('p')).text).toBe('B');
    expect((await rr.complete('p')).text).toBe('A');
  });

  it('fails over to the next provider when one throws', async () => {
    const failing = stubProvider('A', async () => {
      throw new Error('Z.AI API request failed (429): quota');
    });
    const working = stubProvider('B');
    const rr = new RoundRobinProvider([failing, working]);

    const result = await rr.complete('p');
    expect(result.text).toBe('B');
  });

  it('throws the last error when all providers fail', async () => {
    const a = stubProvider('A', async () => {
      throw new Error('429 a');
    });
    const b = stubProvider('B', async () => {
      throw new Error('429 b');
    });
    const rr = new RoundRobinProvider([a, b]);

    await expect(rr.complete('p')).rejects.toThrow('429 b');
  });
});
