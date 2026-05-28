import { Database } from 'bun:sqlite';
import { embedQuery } from './embeddings.js';
import { log } from './logger.js';

interface QueryNormalizerProvider {
  complete(prompt: string): Promise<{ text: string }>;
}

interface SearchOptions {
  db: Database;
  limit?: number;
  after?: string;
  before?: string;
  sourceKind?: string;
  projects?: string[];
  files?: string[];
  queryNormalizerProvider?: QueryNormalizerProvider;
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
  hasFilters: boolean;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function makeLikePattern(value: string): string {
  return `%${escapeLikePattern(value)}%`;
}

function buildFilterParts(options: Pick<SearchOptions, 'after' | 'before' | 'sourceKind' | 'projects' | 'files'>): FilterParts {
  const { after, before, sourceKind, projects, files } = options;
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

  if (projects && projects.length > 0) {
    filters.push(`e.project IN (${projects.map(() => '?').join(', ')})`);
    params.push(...projects);
  }

  if (files && files.length > 0) {
    const fileFilters: string[] = [];
    for (const file of files) {
      fileFilters.push(`(
        e.archive_path LIKE ? ESCAPE '\\'
        OR e.user_text LIKE ? ESCAPE '\\'
        OR e.assistant_text LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM tool_calls tc
          WHERE tc.exchange_id = e.id
            AND (tc.input LIKE ? ESCAPE '\\' OR tc.output LIKE ? ESCAPE '\\')
        )
      )`);
      const pattern = makeLikePattern(file);
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    filters.push(`(${fileFilters.join(' OR ')})`);
  }

  return {
    clause: filters.length > 0 ? `AND ${filters.join(' AND ')}` : '',
    params,
    hasFilters: filters.length > 0,
  };
}

function makeSnippet(userText: string, assistantText: string): string {
  const text = [userText, assistantText].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

async function normalizeQuery(query: string, provider?: QueryNormalizerProvider): Promise<string> {
  if (!provider) {
    return query;
  }

  try {
    const result = await provider.complete(`Normalize this search query to concise English. Return only the normalized query.\n\nQuery: ${query}`);
    const normalized = result.text.trim();
    return normalized || query;
  } catch {
    return query;
  }
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
}): ExchangeSearchResult {
  const result: ExchangeSearchResult = {
    id: row.id,
    archivePath: row.archivePath,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    sourceKind: row.sourceKind,
    project: row.project,
    timestamp: row.timestamp,
    snippet: makeSnippet(row.userText, row.assistantText),
  };

  if (row.distance !== undefined) {
    result.score = 1 / (1 + row.distance);
  }

  return result;
}

async function vectorSearch(query: string, options: SearchOptions): Promise<ExchangeSearchResult[]> {
  const { db, limit = 10 } = options;
  log.debug('vector search start', { query, limit });
  const vecStart = Date.now();
  const embedding = await embedQuery(query);

  if (!embedding) {
    return [];
  }

  const filterParts = buildFilterParts(options);
  const candidateLimit = filterParts.hasFilters
    ? Math.max(limit, (db.query('SELECT COUNT(*) AS count FROM exchanges').get() as { count: number }).count)
    : limit;
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
    candidateLimit,
    ...filterParts.params,
    limit,
  ) as Array<Parameters<typeof mapRow>[0]>;

  log.debug('vector results', { count: rows.length, ms: Date.now() - vecStart });
  return rows.map(mapRow);
}

function textSearch(queries: string[], options: SearchOptions): ExchangeSearchResult[] {
  const { db, limit = 10 } = options;
  const filterParts = buildFilterParts(options);
  const queryClauses = queries.map(() => `(e.user_text LIKE ? ESCAPE '\\' OR e.assistant_text LIKE ? ESCAPE '\\')`);
  const queryParams = queries.flatMap(query => {
    const pattern = makeLikePattern(query);
    return [pattern, pattern];
  });
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
    WHERE (${queryClauses.join(' OR ')})
      ${filterParts.clause}
    ORDER BY e.timestamp DESC
    LIMIT ?
  `);

  const rows = stmt.all(
    ...queryParams,
    ...filterParts.params,
    limit,
  ) as Array<Parameters<typeof mapRow>[0]>;

  return rows.map(mapRow);
}

export async function search(
  query: string,
  options: SearchOptions
): Promise<ExchangeSearchResult[]> {
  const { limit = 10, after, before } = options;

  if (after) validateISODate(after, '--after');
  if (before) validateISODate(before, '--before');

  const normalizedQuery = await normalizeQuery(query, options.queryNormalizerProvider);
  const vectorResults = await vectorSearch(normalizedQuery, options);
  const combined: ExchangeSearchResult[] = [...vectorResults];
  const seenIds = new Set(vectorResults.map(result => result.id));

  if (combined.length < limit) {
    const textQueries = normalizedQuery === query ? [query] : [query, normalizedQuery];
    const textResults = textSearch(textQueries, options);
    log.debug('text fallback', { queries: textQueries, count: textResults.length });
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
