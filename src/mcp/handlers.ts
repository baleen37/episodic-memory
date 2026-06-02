import type { Database } from 'bun:sqlite';
import { search, getMemoryRecordLocation } from '../core/search.js';
import { readConversation } from '../core/read.js';
import type { SearchInput, FetchInput } from './schemas.js';

export interface SearchResult {
  id: string;
  kind: 'fact' | 'event';
  text: string;
  score?: number;
}

export async function handleSearch(params: SearchInput, db: Database): Promise<SearchResult[]> {
  const results = await search(params.query, {
    db,
    limit: params.limit,
    after: params.after,
    before: params.before,
  });

  return results.map(result => {
    const card: SearchResult = {
      id: String(result.id),
      kind: result.kind,
      text: result.text,
    };
    if (result.score !== undefined) card.score = Math.round(result.score * 1000) / 1000;
    return card;
  });
}

export function handleFetch(params: FetchInput, db: Database): string {
  const id = typeof params.id === 'string' ? Number(params.id) : params.id;
  if (!Number.isInteger(id)) {
    throw new Error(`Invalid memory record id: ${String(params.id)}`);
  }

  const location = getMemoryRecordLocation(db, id);
  if (location === null) {
    throw new Error(`Memory record not found: ${id}`);
  }

  const result = readConversation(location.archivePath, location.lineStart, location.lineEnd);
  if (result === null) {
    throw new Error(`Archive file not found for memory record ${id}: ${location.archivePath}`);
  }
  return result;
}
