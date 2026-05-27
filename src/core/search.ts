import { Database } from 'bun:sqlite';
import { generateEmbedding } from './embeddings.js';

interface SearchOptions {
  db: Database;
  limit?: number;
  after?: string;
  before?: string;
  sourceKind?: string;
  projects?: string[];
  files?: string[];
  queryNormalizerProvider?: unknown;
}

export interface ExchangeSearchResult {
  id: number;
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  sourceKind: string;
  project: string | null;
  timestamp: number | null;
  snippet: string;
  score?: number;
}

type SearchResult = ExchangeSearchResult & {
  title: string;
  project: string;
  timestamp: number;
};

function isValidCalendarDate(dateStr: string): boolean {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function validateISODate(dateStr: string, paramName: string): void {
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDateRegex.test(dateStr)) {
    throw new Error(`Invalid ${paramName} date: "${dateStr}". Expected YYYY-MM-DD format (e.g., 2025-10-01)`);
  }
  if (!isValidCalendarDate(dateStr)) {
    throw new Error(`Invalid ${paramName} date: "${dateStr}". Not a valid calendar date.`);
  }
}

function isoToTimestamp(isoDate: string): number {
  const [year, month, day] = isoDate.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

interface FilterParts {
  clause: string;
  params: Array<string | number>;
}

function buildFilterParts(after?: string, before?: string, sourceKind?: string): FilterParts {
  const filters: string[] = [];
  const params: Array<string | number> = [];

  if (after) {
    filters.push('e.timestamp >= ?');
    params.push(isoToTimestamp(after));
  }

  if (before) {
    const [year, month, day] = before.split('-').map(Number);
    filters.push('e.timestamp < ?');
    params.push(Date.UTC(year, month - 1, day + 1));
  }

  if (sourceKind) {
    filters.push('e.source_kind = ?');
    params.push(sourceKind);
  }

  return {
    clause: filters.length > 0 ? `AND ${filters.join(' AND ')}` : '',
    params,
  };
}

function makeSnippet(userText: string, assistantText: string): string {
  const text = [userText, assistantText].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function mapRow(row: {
  id: number;
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  sourceKind: string;
  project: string | null;
  timestamp: number | null;
  userText: string;
  assistantText: string;
  distance?: number;
}): SearchResult {
  const snippet = makeSnippet(row.userText, row.assistantText);
  const result: SearchResult = {
    id: row.id,
    archivePath: row.archivePath,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    sourceKind: row.sourceKind,
    project: row.project ?? '',
    timestamp: row.timestamp ?? 0,
    snippet,
    title: snippet,
  };

  if (row.distance !== undefined) {
    result.score = 1 / (1 + row.distance);
  }

  return result;
}

async function vectorSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
  const { db, limit = 10, after, before, sourceKind } = options;
  const embedding = await generateEmbedding(query);

  if (!embedding) {
    return [];
  }

  const filterParts = buildFilterParts(after, before, sourceKind);
  const stmt = db.query(`
    SELECT
      e.id,
      e.archive_path AS archivePath,
      e.line_start AS lineStart,
      e.line_end AS lineEnd,
      e.source_kind AS sourceKind,
      e.project,
      e.timestamp,
      e.user_text AS userText,
      e.assistant_text AS assistantText,
      vec.distance AS distance
    FROM vec_exchanges vec
    INNER JOIN exchanges e ON e.id = vec.rowid
    WHERE vec.embedding MATCH ?
      AND vec.k = ?
      ${filterParts.clause}
    ORDER BY vec.distance ASC
    LIMIT ?
  `);

  const rows = stmt.all(
    Buffer.from(new Float32Array(embedding).buffer),
    limit,
    ...filterParts.params,
    limit,
  ) as Array<Parameters<typeof mapRow>[0]>;

  return rows.map(mapRow);
}

function textSearch(query: string, options: SearchOptions): SearchResult[] {
  const { db, limit = 10, after, before, sourceKind } = options;
  const filterParts = buildFilterParts(after, before, sourceKind);
  const stmt = db.query(`
    SELECT
      e.id,
      e.archive_path AS archivePath,
      e.line_start AS lineStart,
      e.line_end AS lineEnd,
      e.source_kind AS sourceKind,
      e.project,
      e.timestamp,
      e.user_text AS userText,
      e.assistant_text AS assistantText
    FROM exchanges e
    WHERE (e.user_text LIKE ? OR e.assistant_text LIKE ?)
      ${filterParts.clause}
    ORDER BY e.timestamp DESC
    LIMIT ?
  `);

  const likeQuery = `%${query}%`;
  const rows = stmt.all(
    likeQuery,
    likeQuery,
    ...filterParts.params,
    limit,
  ) as Array<Parameters<typeof mapRow>[0]>;

  return rows.map(mapRow);
}

export async function search(
  query: string,
  options: SearchOptions
): Promise<SearchResult[]> {
  const { limit = 10, after, before } = options;

  if (after) validateISODate(after, '--after');
  if (before) validateISODate(before, '--before');

  const vectorResults = await vectorSearch(query, options);
  const combined: SearchResult[] = [...vectorResults];
  const seenIds = new Set(vectorResults.map(result => result.id));

  if (combined.length < limit) {
    const textResults = textSearch(query, options);
    for (const result of textResults) {
      if (combined.length >= limit) {
        break;
      }
      if (seenIds.has(result.id)) {
        continue;
      }
      combined.push(result);
      seenIds.add(result.id);
    }
  }

  return combined.slice(0, limit);
}
