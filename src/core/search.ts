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

export interface MemorySearchResult {
  id: number;
  kind: 'fact' | 'event';
  text: string;
  sourceKind: string;
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  observedAt: number | null;
  project: string | null;
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

function isoToExclusiveNextDayTimestamp(isoDate: string): number {
  const [year, month, day] = isoDate.split('-').map(Number);
  return Date.UTC(year, month - 1, day + 1);
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
    filters.push('m.observed_at >= ?');
    params.push(isoToTimestamp(after));
  }

  if (before) {
    filters.push('m.observed_at < ?');
    params.push(isoToExclusiveNextDayTimestamp(before));
  }

  if (sourceKind) {
    filters.push('m.source_kind = ?');
    params.push(sourceKind);
  }

  if (projects && projects.length > 0) {
    filters.push(`m.project IN (${projects.map(() => '?').join(', ')})`);
    params.push(...projects);
  }

  if (files && files.length > 0) {
    const fileFilters: string[] = [];
    for (const file of files) {
      fileFilters.push(`(
        m.archive_path LIKE ? ESCAPE '\\'
        OR m.text LIKE ? ESCAPE '\\'
      )`);
      const pattern = makeLikePattern(file);
      params.push(pattern, pattern);
    }
    filters.push(`(${fileFilters.join(' OR ')})`);
  }

  return {
    clause: filters.length > 0 ? `AND ${filters.join(' AND ')}` : '',
    params,
    hasFilters: filters.length > 0,
  };
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
  kind: 'fact' | 'event';
  text: string;
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  sourceKind: string;
  project: string | null;
  observedAt: number | null;
  distance?: number;
}): MemorySearchResult {
  const result: MemorySearchResult = {
    id: row.id,
    kind: row.kind,
    text: row.text.length > 400 ? `${row.text.slice(0, 397)}...` : row.text,
    sourceKind: row.sourceKind,
    archivePath: row.archivePath,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    observedAt: row.observedAt,
    project: row.project,
  };

  if (row.distance !== undefined) {
    result.score = 1 / (1 + row.distance);
  }

  return result;
}

async function vectorSearch(query: string, options: SearchOptions): Promise<MemorySearchResult[]> {
  const { db, limit = 10 } = options;
  log.debug('vector search start', { query, limit });
  const vecStart = Date.now();
  const embedding = await embedQuery(query);

  if (!embedding) {
    return [];
  }

  const filterParts = buildFilterParts(options);
  const vectorCount = (db.query('SELECT COUNT(*) AS count FROM vec_memory_records').get() as { count: number }).count;
  const candidateLimit = Math.min(vectorCount, Math.max(limit * 64, 1000));
  const stmt = db.query(`
    SELECT
      m.id,
      m.kind,
      m.text,
      m.archive_path AS archivePath,
      m.line_start AS lineStart,
      m.line_end AS lineEnd,
      m.source_kind AS sourceKind,
      m.project,
      m.observed_at AS observedAt,
      vec.distance AS distance
    FROM vec_memory_records vec
    INNER JOIN memory_records m ON m.id = vec.rowid
    WHERE vec.embedding MATCH ?
      AND vec.k = ?
      AND m.status = 'active'
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

function textSearch(queries: string[], options: SearchOptions): MemorySearchResult[] {
  const { db, limit = 10 } = options;
  const filterParts = buildFilterParts(options);
  const queryClauses = queries.map(() => 'm.text LIKE ? ESCAPE \'\\\'');
  const queryParams = queries.map(query => makeLikePattern(query));
  const stmt = db.query(`
    SELECT
      m.id,
      m.kind,
      m.text,
      m.archive_path AS archivePath,
      m.line_start AS lineStart,
      m.line_end AS lineEnd,
      m.source_kind AS sourceKind,
      m.project,
      m.observed_at AS observedAt
    FROM memory_records m
    WHERE (${queryClauses.join(' OR ')})
      AND m.status = 'active'
      ${filterParts.clause}
    ORDER BY m.observed_at DESC
    LIMIT ?
  `);

  const rows = stmt.all(
    ...queryParams,
    ...filterParts.params,
    limit,
  ) as Array<Parameters<typeof mapRow>[0]>;

  return rows.map(mapRow);
}

export interface MemoryRecordLocation {
  archivePath: string;
  lineStart: number;
  lineEnd: number;
}

export function getMemoryRecordLocation(db: Database, id: number): MemoryRecordLocation | null {
  const row = db.query(`
    SELECT
      archive_path AS archivePath,
      line_start AS lineStart,
      line_end AS lineEnd
    FROM memory_records
    WHERE id = ? AND status = 'active'
  `).get(id) as MemoryRecordLocation | null;
  return row ?? null;
}

export async function search(
  query: string,
  options: SearchOptions
): Promise<MemorySearchResult[]> {
  const { limit = 10, after, before } = options;

  if (after) validateISODate(after, '--after');
  if (before) validateISODate(before, '--before');

  const normalizedQuery = await normalizeQuery(query, options.queryNormalizerProvider);
  const vectorResults = await vectorSearch(normalizedQuery, options);
  const textQueries = normalizedQuery === query ? [query] : [query, normalizedQuery];
  const fallbackResults = textSearch(textQueries, options);
  log.debug('text fallback', { queries: textQueries, count: fallbackResults.length });

  const combined = new Map<number, MemorySearchResult>();
  for (const result of vectorResults) combined.set(result.id, result);
  for (const result of fallbackResults) if (!combined.has(result.id)) combined.set(result.id, result);
  return Array.from(combined.values()).slice(0, limit);
}
