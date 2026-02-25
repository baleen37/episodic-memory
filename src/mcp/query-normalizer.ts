/**
 * Query normalizer cache for LLM-based query translation.
 *
 * Caches the LLM provider used for query normalization to avoid
 * recreating it on every search request.
 */

import type { LLMConfig, LLMProvider } from '../core/llm/index.js';
import { logDebug } from '../core/logger.js';

export type QueryNormalizerConfig = Pick<LLMConfig, 'provider' | 'model' | 'apiKey'>;

export type LoadConfigFn = () => LLMConfig | null;
export type CreateProviderFn = (config: LLMConfig) => Promise<LLMProvider>;

// Cache state
let cachedProvider: LLMProvider | undefined;
let cachedConfigKey: string | null = null;
let inFlightProvider: Promise<LLMProvider | undefined> | null = null;
let inFlightConfigKey: string | null = null;

/**
 * Reset the query normalizer cache. For testing only.
 */
export function resetQueryNormalizerCache(): void {
  cachedProvider = undefined;
  cachedConfigKey = null;
  inFlightProvider = null;
  inFlightConfigKey = null;
}

function getConfigCacheKey(config: QueryNormalizerConfig): string {
  return JSON.stringify([config.provider, config.model, config.apiKey]);
}

/**
 * Get or create a cached LLM provider for query normalization.
 *
 * Handles:
 * - Missing config (returns undefined)
 * - Provider creation errors (returns undefined, logs debug)
 * - Concurrent requests (deduplicates via in-flight promise)
 *
 * @param loadConfig - Function to load LLM config
 * @param createProvider - Function to create LLM provider
 * @returns Cached LLM provider or undefined if unavailable
 */
export async function getQueryNormalizerProvider(
  loadConfig: LoadConfigFn,
  createProvider: CreateProviderFn
): Promise<LLMProvider | undefined> {
  const config = loadConfig();
  if (!config) {
    return undefined;
  }

  const configKey = getConfigCacheKey(config);

  // Return cached provider if config matches
  if (cachedProvider && cachedConfigKey === configKey) {
    return cachedProvider;
  }

  // Deduplicate concurrent requests with same config
  if (inFlightProvider && inFlightConfigKey === configKey) {
    return inFlightProvider;
  }

  // Create new provider
  const providerPromise = createProvider(config)
    .then(provider => {
      cachedProvider = provider;
      cachedConfigKey = configKey;
      return provider;
    })
    .catch(error => {
      logDebug('query-normalizer: unavailable, falling back to original query', {
        error: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    })
    .finally(() => {
      if (inFlightConfigKey === configKey) {
        inFlightProvider = null;
        inFlightConfigKey = null;
      }
    });

  inFlightProvider = providerPromise;
  inFlightConfigKey = configKey;

  return providerPromise;
}
