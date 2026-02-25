/**
 * MCP tool handlers.
 *
 * Pure functions that implement the business logic for each tool.
 * Separated from MCP protocol wiring for testability.
 */

import type { Database } from 'bun:sqlite';
import { search } from '../core/search.js';
import { findByIds as getObservationsByIds } from '../core/observations.js';
import { readConversation } from '../core/read.js';
import { getQueryNormalizerProvider, type LoadConfigFn, type CreateProviderFn } from './query-normalizer.js';
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

  const observations = await getObservationsByIds(db, numericIds);

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
