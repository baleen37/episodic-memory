import type { Database } from 'bun:sqlite';
import { EmbeddingError, embedQuery } from '../embeddings.js';
import { log } from '../logger.js';
import { assertScoped, buildFilterSql, type Filters } from './filters.js';
import {
  buildFtsMatchQuery, getBm25Params, lemmatizeForBm25, normalizeBm25, scoreAndRank,
  type Candidate, type ScoreDetails,
} from './scoring.js';

const MAX_KNN_K = 4096;

export interface SearchArgs {
  db: Database;
  query: string;
  filters: Filters;
  limit?: number;
  threshold?: number;
  explain?: boolean;
}

export interface MultiSearchArgs extends Omit<SearchArgs, 'query'> {
  queries: string[];
}

export interface SearchResultItem {
  id: string;
  memory: string;
  hash: string;
  metadata: Record<string, unknown>;
  score: number;
  created_at: number;
  updated_at: number;
  score_details?: ScoreDetails;
}

const PROMOTED_PAYLOAD_KEYS = [
  'user_id', 'agent_id', 'run_id', 'actor_id', 'role', 'attributed_to', 'expiration_date',
] as const;

function validateThreshold(threshold: number): void {
  if (typeof threshold !== 'number' || Number.isNaN(threshold)) {
    throw new Error('threshold must be a valid number');
  }
  if (threshold < 0 || threshold > 1) {
    throw new Error(`Invalid threshold: ${threshold}. Must be between 0 and 1 (inclusive).`);
  }
}

/** Port of main.py:_search_vector_store (v2.0.17). */
export async function searchMemories(args: SearchArgs): Promise<{ results: SearchResultItem[] }> {
  const { db, query, filters, limit = 20, explain = false } = args;
  const threshold = args.threshold ?? 0.1;

  validateThreshold(threshold);
  assertScoped(filters);

  const queryLemmatized = lemmatizeForBm25(query);
  let embedding: number[] | null;
  try {
    embedding = await embedQuery(query);
  } catch (err) {
    if (!(err instanceof EmbeddingError)) throw err;
    // Search degrades to empty rather than failing: an unavailable embedder
    // should not break the caller. Logged because it is otherwise invisible.
    log.warn('search embedding failed; returning no results', { error: err.message });
    return { results: [] };
  }
  if (!embedding) return { results: [] };

  const internalLimit = Math.max(limit * 4, 60);
  const { clause, params } = buildFilterSql(filters);
  const filterClause = clause ? `AND ${clause}` : '';

  const vectorCount = (db.query('SELECT COUNT(*) AS c FROM vec_memories').get() as { c: number }).c;
  if (vectorCount === 0) return { results: [] };
  const maxK = Math.min(vectorCount, MAX_KNN_K);

  const semanticQuery = db.query(`
    SELECT m.id AS id, m.memory AS memory, m.hash AS hash, m.metadata AS metadata,
           m.created_at AS created_at, m.updated_at AS updated_at,
           m.rowid AS rowid, vec.distance AS distance
    FROM vec_memories vec
    INNER JOIN memories m ON m.rowid = vec.rowid
    WHERE vec.embedding MATCH ? AND vec.k = ?
      ${filterClause}
    ORDER BY vec.distance ASC
    LIMIT ?
  `);

  // A selective metadata filter is applied to the KNN candidate set *after* sqlite-vec
  // has already chosen its k nearest rows — a narrow filter can otherwise starve the
  // result set even when far more matching rows exist beyond the initial k. Widen k
  // and retry until enough post-filter rows are found or the KNN space is exhausted.
  let k = Math.min(maxK, Math.max(internalLimit, 1));
  let semanticRows: Array<{
    id: string; memory: string; hash: string; metadata: string;
    created_at: number; updated_at: number; rowid: number; distance: number;
  }>;
  for (;;) {
    semanticRows = semanticQuery.all(
      Buffer.from(new Float32Array(embedding).buffer), k, ...(params as never[]), internalLimit,
    ) as typeof semanticRows;
    if (semanticRows.length >= internalLimit || k >= maxK) break;
    k = Math.min(maxK, k * 2);
  }

  const byRowid = new Map(semanticRows.map(r => [r.rowid, r]));

  // FTS5 bm25() returns negative values where more negative is better; flip the sign.
  const bm25Scores: Record<string, number> = {};
  if (queryLemmatized) {
    const [midpoint, steepness] = getBm25Params(query, queryLemmatized);
    try {
      const keywordRows = db.query(`
        SELECT rowid, bm25(fts_memories) AS raw
        FROM fts_memories WHERE fts_memories MATCH ?
        ORDER BY raw LIMIT ?
      `).all(buildFtsMatchQuery(queryLemmatized), internalLimit) as Array<{ rowid: number; raw: number }>;

      for (const row of keywordRows) {
        const semantic = byRowid.get(row.rowid);
        if (!semantic) continue;
        const rawScore = -row.raw;
        if (rawScore > 0) {
          bm25Scores[semantic.id] = normalizeBm25(rawScore, midpoint, steepness);
        }
      }
    } catch {
      // Malformed FTS5 query syntax — proceed with semantic only.
    }
  }

  // Entity boosts are computed from entities linked to matched memories.
  const entityBoosts: Record<string, number> = {};

  const candidates: Candidate[] = semanticRows.map(row => ({
    id: row.id,
    score: 1 - row.distance,
    payload: {
      data: row.memory,
      hash: row.hash,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  }));

  const scored = scoreAndRank({
    semanticResults: candidates,
    bm25Scores,
    entityBoosts,
    threshold,
    topK: limit,
    explain,
  });

  const results: SearchResultItem[] = [];
  for (const item of scored) {
    const payload = item.payload;
    if (!payload || !payload.data) continue;

    const metadata = JSON.parse((payload.metadata as string) || '{}') as Record<string, unknown>;
    const result: SearchResultItem = {
      id: item.id,
      memory: payload.data as string,
      hash: payload.hash as string,
      metadata,
      score: item.score,
      created_at: payload.created_at as number,
      updated_at: payload.updated_at as number,
    };
    for (const key of PROMOTED_PAYLOAD_KEYS) {
      if (metadata[key] !== undefined) {
        (result as unknown as Record<string, unknown>)[key] = metadata[key];
      }
    }
    if (item.score_details) result.score_details = item.score_details;
    results.push(result);
  }

  return { results };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanScoreDetails(details: ScoreDetails[]): ScoreDetails {
  return {
    semantic_score: mean(details.map(detail => detail.semantic_score)),
    bm25_score: mean(details.map(detail => detail.bm25_score)),
    entity_boost: mean(details.map(detail => detail.entity_boost)),
    raw_score: mean(details.map(detail => detail.raw_score)),
    max_possible_score: mean(details.map(detail => detail.max_possible_score)),
    final_score: mean(details.map(detail => detail.final_score)),
    threshold: details[0].threshold,
  };
}

export async function searchMemoriesMulti(
  args: MultiSearchArgs,
): Promise<{ results: SearchResultItem[] }> {
  const { db, filters, queries, limit = 20, threshold, explain = false } = args;
  if (queries.length === 0) return { results: [] };
  if (queries.length === 1) {
    return searchMemories({ db, query: queries[0], filters, limit, threshold, explain });
  }

  // Oversample each query before intersecting so a shared record is not lost
  // merely because it ranks below the final result limit for one query.
  const candidateLimit = Math.min(MAX_KNN_K, Math.max(limit * 5, 60));
  const perQuery = await Promise.all(
    queries.map(query => searchMemories({
      db,
      query,
      filters,
      limit: candidateLimit,
      threshold,
      explain,
    })),
  );

  const byId = new Map<string, {
    item: SearchResultItem;
    scores: number[];
    details: ScoreDetails[];
  }>();

  for (const { results } of perQuery) {
    for (const result of results) {
      const entry = byId.get(result.id);
      if (entry) {
        entry.scores.push(result.score);
        if (result.score_details) entry.details.push(result.score_details);
      } else {
        byId.set(result.id, {
          item: result,
          scores: [result.score],
          details: result.score_details ? [result.score_details] : [],
        });
      }
    }
  }

  const results: SearchResultItem[] = [];
  for (const { item, scores, details } of byId.values()) {
    if (scores.length !== queries.length) continue;

    const score = mean(scores);
    const result = { ...item, score };
    if (explain && details.length === queries.length) {
      result.score_details = meanScoreDetails(details);
    }
    results.push(result);
  }

  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { results: results.slice(0, limit) };
}
