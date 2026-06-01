import type { Database } from 'bun:sqlite';
import { search } from '../core/search.js';
import { readConversation } from '../core/read.js';
import type { SearchInput, ReadInput } from './schemas.js';

export interface SearchResult {
  id: string;
  kind: 'fact' | 'event';
  text: string;
  archive_path: string;
  line_start: number;
  line_end: number;
  source_kind: string;
  project: string | null;
  timestamp: number | null;
  score?: number;
}

export async function handleSearch(params: SearchInput, db: Database): Promise<SearchResult[]> {
  const results = await search(params.query, {
    db,
    limit: params.limit,
    after: params.after,
    before: params.before,
    sourceKind: params.source_kind,
  });

  return results.map(result => ({
    id: String(result.id),
    kind: result.kind,
    text: result.text,
    archive_path: result.archivePath,
    line_start: result.lineStart,
    line_end: result.lineEnd,
    source_kind: result.sourceKind,
    project: result.project,
    timestamp: result.observedAt,
    score: result.score,
  }));
}

export function handleRead(params: ReadInput): string {
  const result = readConversation(params.path, params.startLine, params.endLine);
  if (result === null) {
    throw new Error(`File not found: ${params.path}`);
  }
  return result;
}
