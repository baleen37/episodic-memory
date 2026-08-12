/**
 * LLM Configuration for Stop Hook Batch Extraction
 *
 * This module provides:
 * - LLMConfig interface for configuration file structure
 * - loadConfig() function to read configuration from ~/.config/memmem/config.json
 * - createProvider() factory function to create LLMProvider instances from config
 *
 * Configuration file location: ~/.config/memmem/config.json
 *
 * @example
 * ```json
 * {
 *   "provider": "gemini",
 *   "apiKey": "your-gemini-api-key",
 *   "model": "gemini-2.0-flash",
 *   "ratelimit": {
 *     "embedding": { "requestsPerSecond": 5, "burstSize": 10 },
 *     "llm": { "requestsPerSecond": 2, "burstSize": 4 }
 *   },
 *   "embedding": { "maxConcurrency": 4 }
 * }
 * ```
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { LLMProvider } from './types.js';

/**
 * Supported LLM provider types.
 */
export type LLMProviderType = 'gemini' | 'zai';

/**
 * Default models for each provider.
 */
const DEFAULT_MODELS = {
  gemini: 'gemini-2.0-flash',
  zai: 'glm-4.5-air'
} as const;

/**
 * Rate limiter configuration for a single limiter.
 */
export interface RateLimitConfig {
  /** Maximum requests per second (token refill rate) */
  requestsPerSecond?: number;
  /** Maximum tokens in bucket (burst capacity) */
  burstSize?: number;
}

/**
 * Rate limiter configuration for all limiters.
 */
export interface RateLimitsConfig {
  /** Rate limiter for embedding generation */
  embedding?: RateLimitConfig;
  /** Rate limiter for LLM API calls */
  llm?: RateLimitConfig;
}

/** Default number of embedding calls allowed to run at once. */
export const DEFAULT_EMBEDDING_MAX_CONCURRENCY = 4;

/**
 * Embedding configuration.
 *
 * The embedding model runs in-process on CPU, so throughput is bounded by
 * concurrency rather than by a request rate.
 */
export interface EmbeddingConfig {
  /** Maximum embedding calls allowed to run at once (default 4) */
  maxConcurrency?: number;
}

/**
 * LLM configuration interface.
 *
 * Defines the structure of the config file at ~/.config/memmem/config.json
 */
/**
 * A single (apiKey, model) combination for round-robin rotation.
 */
export interface ProviderEntry {
  /**
   * Optional account email this key belongs to. Purely informational — it
   * labels which Google account issued the key, since the key itself cannot be
   * traced back to an account via the API.
   */
  email?: string;
  /** API key for the provider */
  apiKey: string;
  /** Optional model name (defaults depend on provider) */
  model?: string;
}

export interface LLMConfig {
  /** Provider: 'gemini' or 'zai' */
  provider: LLMProviderType;
  /** API key for the provider (single-provider mode) */
  apiKey?: string;
  /** Optional model name (defaults depend on provider) */
  model?: string;
  /**
   * Optional list of (apiKey, model) combinations. When present, calls rotate
   * across these entries and fail over to the next on error, pooling free-tier
   * quota across keys/models.
   */
  providers?: ProviderEntry[];
  /** Optional rate limiter configuration */
  ratelimit?: RateLimitsConfig;
  /** Optional embedding configuration */
  embedding?: EmbeddingConfig;
}

let configFileDeps = {
  existsSync,
  readFileSync,
};

export function __setConfigFileDepsForTests(
  deps: { existsSync: typeof existsSync; readFileSync: typeof readFileSync } | null
): void {
  configFileDeps = deps ?? { existsSync, readFileSync };
}

/**
 * Loads LLM configuration from the config file.
 *
 * Reads ~/.config/memmem/config.json and parses it.
 *
 * @returns LLMConfig if file exists and is valid, null otherwise
 *
 * @example
 * ```ts
 * const config = loadConfig();
 * if (config) {
 *   const provider = createProvider(config);
 * } else {
 *   console.log('No config file found');
 * }
 * ```
 */
export function loadConfig(): LLMConfig | null {
  const configDir = join(process.env.HOME ?? '', '.config', 'memmem');
  const configPath = join(configDir, 'config.json');

  // Return null if config file doesn't exist
  if (!configFileDeps.existsSync(configPath)) {
    return null;
  }

  try {
    const configContent = configFileDeps.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configContent) as LLMConfig;

    // Validate required fields. Either a single apiKey or a non-empty
    // providers[] (round-robin mode) must be present.
    const hasProviders = Array.isArray(config.providers) && config.providers.length > 0;
    if (!config.provider || (!config.apiKey && !hasProviders)) {
      console.warn('Invalid config: missing provider or apiKey field');
      return null;
    }

    // Validate provider value
    if (config.provider !== 'gemini' && config.provider !== 'zai') {
      console.warn(`Invalid config: unknown provider "${config.provider}"`);
      return null;
    }

    return config;
  } catch (error) {
    console.warn(
      `Failed to load config from ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Creates an LLMProvider from configuration.
 *
 * Supports 'gemini' and 'zai' providers.
 * Uses provider-specific default models if not specified.
 *
 * @param config - LLM configuration object
 * @returns Configured LLMProvider instance
 * @throws {Error} If apiKey is missing or provider is unknown
 *
 * @example
 * ```ts
 * const config: LLMConfig = {
 *   provider: 'gemini',
 *   apiKey: 'your-api-key',
 *   model: 'gemini-2.0-flash'
 * };
 * const provider = await createProvider(config);
 * const result = await provider.complete('Extract event/fact memory records');
 * ```
 */
export async function createProvider(config: LLMConfig): Promise<LLMProvider> {
  const { provider, apiKey, model, providers } = config;

  // Round-robin mode: build one provider per (apiKey, model) entry and rotate.
  if (providers) {
    const { RoundRobinProvider } = await import('./round-robin-provider.js');
    const built = await Promise.all(
      providers.map((entry) =>
        createProvider({ provider, apiKey: entry.apiKey, model: entry.model }),
      ),
    );
    return new RoundRobinProvider(built);
  }

  if (!apiKey) {
    throw new Error('Provider requires an apiKey');
  }

  const defaultModel = model ?? DEFAULT_MODELS[provider];

  if (provider === 'gemini') {
    const { GeminiProvider } = await import('./gemini-provider.js');
    return new GeminiProvider(apiKey, defaultModel);
  } else if (provider === 'zai') {
    const { ZAIProvider } = await import('./zai-provider.js');
    return new ZAIProvider(apiKey, defaultModel);
  }

  throw new Error(`Unknown provider: ${provider}`);
}
