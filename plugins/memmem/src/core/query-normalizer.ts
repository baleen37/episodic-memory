/**
 * Resolves the optional query normalizer used by search to translate/normalize
 * queries (e.g. Korean → English) before embedding. Backed by the configured LLM
 * provider. Returns undefined when no provider is configured or creation fails,
 * so search degrades gracefully to the raw query.
 */
import { createProvider as defaultCreateProvider, loadConfig as defaultLoadConfig } from './llm/config.js';
import type { LLMConfig } from './llm/config.js';
import type { LLMProvider } from './llm/types.js';
import { log } from './logger.js';

interface ResolveDeps {
  loadConfig: () => LLMConfig | null;
  createProvider: (config: LLMConfig) => Promise<LLMProvider>;
}

export async function resolveQueryNormalizer(
  deps: ResolveDeps = { loadConfig: defaultLoadConfig, createProvider: defaultCreateProvider },
): Promise<LLMProvider | undefined> {
  const config = deps.loadConfig();
  if (!config) return undefined;
  try {
    return await deps.createProvider(config);
  } catch (err) {
    log.warn('query normalizer unavailable', { error: (err as Error).message });
    return undefined;
  }
}
