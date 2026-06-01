import type { LLMProvider, LLMOptions, LLMResult } from './types.js';

/**
 * Wraps multiple LLMProviders and rotates between them on each call.
 *
 * Used to spread load across several (apiKey, model) combinations so free-tier
 * per-minute quotas are pooled rather than exhausted on a single key.
 */
export class RoundRobinProvider implements LLMProvider {
  private readonly providers: LLMProvider[];
  private cursor = 0;

  constructor(providers: LLMProvider[]) {
    if (providers.length === 0) {
      throw new Error('RoundRobinProvider requires at least one provider');
    }
    this.providers = providers;
  }

  async complete(prompt: string, options?: LLMOptions): Promise<LLMResult> {
    let lastError: unknown;
    // Try each provider once, starting at the cursor, advancing on failure so a
    // 429/quota error fails over to the next (apiKey, model) combination.
    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[this.cursor];
      this.cursor = (this.cursor + 1) % this.providers.length;
      try {
        return await provider.complete(prompt, options);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}
