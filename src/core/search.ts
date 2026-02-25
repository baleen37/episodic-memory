/**
 * Observation Search
 *
 * Search using observations table with vector similarity.
 */

import { Database } from 'bun:sqlite';
import { generateEmbedding, initEmbeddings } from './embeddings.js';
import type { LLMProvider } from './llm/types.js';

interface SearchOptions {
  limit?: number;
  after?: string;  // ISO date string
  before?: string; // ISO date string
  projects?: string[]; // Filter by project names
  files?: string[]; // Filter by file paths mentioned in content
  queryNormalizerProvider?: LLMProvider; // Optional provider to normalize query to English
}

/**
 * Compact observation result (Layer 1 of progressive disclosure)
 */
export interface ObservationSummary {
  id: number;
  title: string;
  project: string;
  timestamp: number;
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

async function normalizeQueryToEnglish(
  query: string,
  queryNormalizerProvider?: LLMProvider
): Promise<string> {
  if (!queryNormalizerProvider) {
    return query;
  }

  const normalizePrompt = [
    'Normalize the following search query into concise English for memory retrieval.',
    'Preserve technical terms, file paths, and identifiers exactly.',
    'Return only the normalized English query text with no explanation.',
    '',
    query,
  ].join('\n');

  try {
    const result = await queryNormalizerProvider.complete(normalizePrompt, {
      maxTokens: 128,
      systemPrompt: 'You normalize search queries to concise English only.'
    });
    const normalized = result.text.trim();
    return normalized.length > 0 ? normalized : query;
  } catch {
    return query;
  }
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

/**
 * Convert ISO date string to Unix timestamp (milliseconds)
 */
function isoToTimestamp(isoDate: string): number {
  const [year, month, day] = isoDate.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

interface SharedFilterParts {
  timeClause: string;
  timeFilterParams: number[];
  projectClause: string;
  projectFilterParams: string[];
  fileClause: string;
  fileFilterParams: string[];
}

function buildSharedFilterParts(
  after?: string,
  before?: string,
  projects?: string[],
  files?: string[]
): SharedFilterParts {
  const timeFilter: string[] = [];
  const timeFilterParams: number[] = [];
  if (after) {
    timeFilter.push('o.timestamp >= ?');
    timeFilterParams.push(isoToTimestamp(after));
  }
  if (before) {
    const [year, month, day] = before.split('-').map(Number);
    const nextDayStart = Date.UTC(year, month - 1, day + 1);
    timeFilter.push('o.timestamp < ?');
    timeFilterParams.push(nextDayStart);
  }
  const timeClause = timeFilter.length > 0 ? `AND ${timeFilter.join(' AND ')}` : '';

  const projectFilter: string[] = [];
  const projectFilterParams: string[] = [];
  if (projects && projects.length > 0) {
    const projectPlaceholders = projects.map(() => '?').join(',');
    projectFilter.push(`o.project IN (${projectPlaceholders})`);
    projectFilterParams.push(...projects);
  }
  const projectClause = projectFilter.length > 0 ? `AND ${projectFilter.join(' AND ')}` : '';

  const fileFilter: string[] = [];
  const fileFilterParams: string[] = [];
  if (files && files.length > 0) {
    const fileClauses = files.map(() => 'instr(o.content, ?) > 0').join(' OR ');
    fileFilter.push(`(${fileClauses})`);
    fileFilterParams.push(...files);
  }
  const fileClause = fileFilter.length > 0 ? `AND ${fileFilter.join(' AND ')}` : '';

  return {
    timeClause,
    timeFilterParams,
    projectClause,
    projectFilterParams,
    fileClause,
    fileFilterParams
  };
}

async function vector_search(
  query: string,
  options: SearchOptions & { db: Database }
): Promise<ObservationSummary[]> {
  const { db, limit = 10, after, before, projects, files } = options;
  const {
    timeClause,
    timeFilterParams,
    projectClause,
    projectFilterParams,
    fileClause,
    fileFilterParams
  } = buildSharedFilterParts(after, before, projects, files);

  await initEmbeddings();
  const queryEmbedding = await generateEmbedding(query);

  // If embeddings are disabled, return empty array (fallback to keyword search)
  if (!queryEmbedding) {
    return [];
  }

  // Request more vector candidates when file filters are present to avoid early cutoff.
  const vectorCandidateLimit = files && files.length > 0 ? Math.max(limit * 5, limit) : limit;

  const stmt = db.query(`
    SELECT
      o.id,
      o.title,
      o.project,
      o.timestamp
    FROM observations o
    INNER JOIN vec_observations vec ON CAST(o.id AS TEXT) = vec.id
    WHERE vec.embedding MATCH ?
      AND vec.k = ?
      ${timeClause}
      ${projectClause}
      ${fileClause}
    ORDER BY vec.distance ASC
    LIMIT ?
  `);

  const vectorParams = [
    Buffer.from(new Float32Array(queryEmbedding).buffer),
    vectorCandidateLimit,
    ...timeFilterParams,
    ...projectFilterParams,
    ...fileFilterParams,
    limit
  ];

  return stmt.all(...vectorParams) as ObservationSummary[];
}

function keyword_search(
  query: string,
  options: SearchOptions & { db: Database }
): ObservationSummary[] {
  const { db, limit = 10, after, before, projects, files } = options;
  const {
    timeClause,
    timeFilterParams,
    projectClause,
    projectFilterParams,
    fileClause,
    fileFilterParams
  } = buildSharedFilterParts(after, before, projects, files);

  const stmt = db.query(`
    SELECT
      o.id,
      o.title,
      o.project,
      o.timestamp
    FROM observations o
    WHERE o.content LIKE ?
      ${timeClause}
      ${projectClause}
      ${fileClause}
    ORDER BY o.timestamp DESC
    LIMIT ?
  `);

  const keywordParams = [
    `%${query}%`,
    ...timeFilterParams,
    ...projectFilterParams,
    ...fileFilterParams,
    limit
  ];

  return stmt.all(...keywordParams) as ObservationSummary[];
}

/**
 * Search observations using hybrid strategy:
 * vector_search first, then keyword_search fallback when needed.
 * Returns compact observations (Layer 1 of progressive disclosure).
 *
 * @param query - Search query string
 * @param options - Search options
 * @returns Array of compact observation results
 */
export async function search(
  query: string,
  options: SearchOptions & { db: Database }
): Promise<ObservationSummary[]> {
  const { db, limit = 10, after, before, projects, files, queryNormalizerProvider } = options;

  if (after) validateISODate(after, '--after');
  if (before) validateISODate(before, '--before');

  const normalizedQuery = await normalizeQueryToEnglish(query, queryNormalizerProvider);

  const vectorResults = await vector_search(normalizedQuery, { db, limit, after, before, projects, files });
  if (vectorResults.length >= limit) {
    return vectorResults.slice(0, limit);
  }

  const keywordResults = keyword_search(normalizedQuery, {
    db,
    limit,
    after,
    before,
    projects,
    files
  });

  const combined: ObservationSummary[] = [...vectorResults];
  const seenIds = new Set(vectorResults.map(result => result.id));

  for (const result of keywordResults) {
    if (combined.length >= limit) {
      break;
    }
    if (seenIds.has(result.id)) {
      continue;
    }
    combined.push(result);
    seenIds.add(result.id);
  }

  return combined;
}
