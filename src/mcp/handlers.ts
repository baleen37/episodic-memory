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
import type { SearchInput, GetObservationsInput, ReadInput } from './schemas.js';
import { getNormalizerProvider, type LoadConfigFn, type CreateProviderFn } from './normalizer.js';

export type { LoadConfigFn, CreateProviderFn };

// Types for handler outputs

export interface SearchResult {
  id: string;
  title: string;
  project: string;
  timestamp: number;
}

interface ObservationOutput {
  id: number;
  title: string;
  content: string;
  project: string;
  timestamp: number;
  content_original?: string;
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
  const queryNormalizerProvider = await getNormalizerProvider(loadConfig, createProvider);

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
    title: r.snippet,
    project: r.project ?? '',
    timestamp: r.timestamp ?? 0,
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
