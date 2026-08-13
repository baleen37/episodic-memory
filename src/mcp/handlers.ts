import type { Database } from 'bun:sqlite';
import { searchMemories, type SearchResultItem } from '../core/memory/search.js';
import { LOCAL_USER_ID } from '../core/constants.js';

export interface SearchInput {
  query: string;
  limit?: number;
  threshold?: number;
  explain?: boolean;
}

export async function handleSearch(
  params: SearchInput,
  db: Database,
): Promise<{ results: SearchResultItem[] }> {
  return searchMemories({
    db,
    query: params.query,
    filters: { user_id: LOCAL_USER_ID },
    limit: params.limit,
    threshold: params.threshold,
    explain: params.explain,
  });
}
