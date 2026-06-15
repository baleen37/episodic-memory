import type { LLMConfig, LLMProvider } from '../core/llm/index.js';
import { logDebug } from '../core/logger.js';

export type NormalizerConfig = Pick<LLMConfig, 'provider' | 'model' | 'apiKey'>;
export type LoadConfigFn = () => LLMConfig | null;
export type CreateProviderFn = (config: LLMConfig) => Promise<LLMProvider>;

let cachedProvider: LLMProvider | undefined;
let cachedConfigKey: string | null = null;
let inFlightProvider: Promise<LLMProvider | undefined> | null = null;
let inFlightConfigKey: string | null = null;

/**
 * Reset the normalizer cache. For testing only.
 */
export function resetNormalizerCache(): void {
  cachedProvider = undefined;
  cachedConfigKey = null;
  inFlightProvider = null;
  inFlightConfigKey = null;
}

function getConfigCacheKey(config: NormalizerConfig): string {
  return JSON.stringify([config.provider, config.model, config.apiKey]);
}

export async function getNormalizerProvider(
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
