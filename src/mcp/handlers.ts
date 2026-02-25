/**
 * MCP tool handlers.
 *
 * Pure functions that implement the business logic for each tool.
 * Separated from MCP protocol wiring for testability.
 */

import type { Database } from 'bun:sqlite';
import { search } from '../core/search.js';
import { getObservationsByIds } from '../core/db.js';
import { readConversation } from '../core/read.js';
import type { LLMConfig, LLMProvider } from '../core/llm/index.js';
import { logDebug } from '../core/logger.js';
import type { SearchInput, GetObservationsInput, ReadInput } from './schemas.js';

// Types for handler outputs

export interface SearchResult {
  id: string;
  title: string;
  project: string;
  timestamp: number;
}

export interface ObservationOutput {
  id: number;
  title: string;
  content: string;
  project: string;
  timestamp: number;
  content_original?: string;
}

// Query normalizer types

export type QueryNormalizerConfig = Pick<LLMConfig, 'provider' | 'model' | 'apiKey'>;

export type LoadConfigFn = () => LLMConfig | null;
export type CreateProviderFn = (config: LLMConfig) => Promise<LLMProvider>;

// Query normalizer cache state

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

/**
 * Format observations as human-readable text.
 */
export function formatObservations(
  observations: ObservationOutput[],
  includeOriginal: boolean
): string {
  if (observations.length === 0) {
    return 'No observations found.';
  }

  let output = `Retrieved ${observations.length} observation${observations.length > 1 ? 's' : ''}:\n\n`;

  for (const obs of observations) {
    const date = new Date(obs.timestamp).toISOString().split('T')[0];
    const time = new Date(obs.timestamp).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    output += `## [${obs.project}, ${date} ${time}] - ${obs.title}\n\n`;
    output += `${obs.content}\n\n`;
    if (includeOriginal && obs.content_original) {
      output += `Original: ${obs.content_original}\n\n`;
    }
    output += `---\n\n`;
  }

  return output;
}

// Handlers

export async function handleSearch(
  params: SearchInput,
  db: Database,
  loadConfig: LoadConfigFn,
  createProvider: CreateProviderFn
): Promise<SearchResult[]> {
  const queryNormalizerProvider = await getQueryNormalizerProvider(loadConfig, createProvider);

  const results = await search(params.query, {
    db,
    limit: params.limit,
    after: params.after,
    before: params.before,
    projects: params.projects,
    files: params.files,
    queryNormalizerProvider,
  });

  return results.map(r => ({
    id: String(r.id),
    title: r.title,
    project: r.project,
    timestamp: r.timestamp,
  }));
}

export async function handleGetObservations(
  params: GetObservationsInput,
  db: Database
): Promise<ObservationOutput[]> {
  // Convert string IDs to numbers
  const numericIds = params.ids.map(id =>
    typeof id === 'string' ? parseInt(id, 10) : id
  );

  const observations = getObservationsByIds(db, numericIds);

  return observations.map(obs => ({
    id: obs.id,
    title: obs.title,
    content: obs.content,
    project: obs.project,
    timestamp: obs.timestamp,
    ...(params.includeOriginal && obs.contentOriginal ? { content_original: obs.contentOriginal } : {}),
  }));
}

export function handleRead(params: ReadInput): string {
  const result = readConversation(params.path, params.startLine, params.endLine);
  if (result === null) {
    throw new Error(`File not found: ${params.path}`);
  }
  return result;
}
