import type { Database } from 'bun:sqlite';
import { search, searchMulti, listRecent, getMemoryRecordLocation } from '../core/search.js';
import type { SearchInput, FetchInput } from './schemas.js';

export interface SearchResult {
  id: string;
  kind: 'fact' | 'event';
  project: string | null;
  description: string;
  score?: number;
}

export async function handleSearch(params: SearchInput, db: Database): Promise<SearchResult[]> {
  const options = {
    db,
    limit: params.limit,
    after: params.after,
    before: params.before,
    sourceKind: params.source_kind,
  };
  const results = params.query === undefined
    ? listRecent(options)
    : Array.isArray(params.query)
      ? await searchMulti(params.query, options)
      : await search(params.query, options);

  return results.map(result => {
    const card: SearchResult = {
      id: String(result.id),
      kind: result.kind,
      project: result.project,
      description: result.text,
    };
    if (result.score !== undefined) card.score = Math.round(result.score * 1000) / 1000;
    return card;
  });
}

// TODO(Task 10): `readConversation` (src/core/read.ts) was deleted in Task 9 along
// with the old indexer/extractor pipeline. This handler is temporarily disabled
// pending Task 10's MCP surface rework; it no longer reads archive transcript text.
export function handleFetch(params: FetchInput, db: Database): string {
  const id = typeof params.id === 'string' ? Number(params.id) : params.id;
  if (!Number.isInteger(id)) {
    throw new Error(`Invalid memory record id: ${String(params.id)}`);
  }

  const location = getMemoryRecordLocation(db, id);
  if (location === null) {
    throw new Error(`Memory record not found: ${id}`);
  }

  throw new Error('fetch is temporarily unavailable: archive read path was removed in Task 9 (see Task 10)');
}
