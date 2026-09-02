import type { Database } from 'bun:sqlite';
import {
  searchMemories,
  searchMemoriesMulti,
  type SearchResultItem,
} from '../core/memory/search.js';
import { readMemories } from '../core/memory/read.js';
import { LOCAL_USER_ID } from '../core/constants.js';
import { compactMemoryId, expandMemoryId } from './ids.js';

export interface SearchInput {
  query: string | string[];
  limit?: number;
}

export interface ReadInput {
  ids: string[];
}

export interface CompactSearchResult {
  id: string;
  text: string;
  date: string;
  score: number;
}

export interface ReadMemoryResult {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

function compactScore(score: number): number {
  return Number(score.toFixed(3));
}

function toCompactResult(result: SearchResultItem): CompactSearchResult {
  return {
    id: compactMemoryId(result.id),
    text: result.memory,
    date: new Date(result.created_at).toISOString(),
    score: compactScore(result.score),
  };
}

export async function handleSearch(
  params: SearchInput,
  db: Database,
): Promise<{ results: CompactSearchResult[] }> {
  const options = {
    db,
    filters: { user_id: LOCAL_USER_ID },
    limit: params.limit,
  };

  const result = Array.isArray(params.query)
    ? searchMemoriesMulti({ ...options, queries: params.query })
    : searchMemories({ ...options, query: params.query });
  return { results: (await result).results.map(toCompactResult) };
}

export function handleRead(
  params: ReadInput,
  db: Database,
): { results: ReadMemoryResult[]; missing: string[] } {
  const canonicalIds = params.ids.map(expandMemoryId);
  const records = readMemories(db, canonicalIds);
  const byId = new Map(records.results.map((record) => [record.id, record]));
  const results: ReadMemoryResult[] = [];
  const missing: string[] = [];

  for (const [index, canonicalId] of canonicalIds.entries()) {
    const record = byId.get(canonicalId);
    if (!record || record.metadata.user_id !== LOCAL_USER_ID) {
      missing.push(params.ids[index]);
      continue;
    }
    results.push({
      id: compactMemoryId(record.id),
      text: record.memory,
      metadata: record.metadata,
      created_at: record.created_at,
      updated_at: record.updated_at,
    });
  }

  return { results, missing };
}
