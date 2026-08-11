/** Port of mem0/utils/scoring.py (v2.0.17). Constants must match upstream exactly. */

export const ENTITY_BOOST_WEIGHT = 0.5;

export interface Candidate {
  id: string;
  score: number;
  payload: Record<string, unknown> | null;
}

export interface ScoreDetails {
  semantic_score: number;
  bm25_score: number;
  entity_boost: number;
  raw_score: number;
  max_possible_score: number;
  final_score: number;
  threshold: number;
}

export interface ScoredResult {
  id: string;
  score: number;
  payload: Record<string, unknown> | null;
  score_details?: ScoreDetails;
}

export interface ScoreAndRankArgs {
  semanticResults: Candidate[];
  bm25Scores: Record<string, number>;
  entityBoosts: Record<string, number>;
  threshold: number;
  topK: number;
  explain?: boolean;
}

/**
 * FTS5 unicode61 has no lemmatizer, so this is lowercase + whitespace collapse.
 * Sanctioned deviation: mem0 uses spaCy lemmatization.
 */
export function lemmatizeForBm25(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** scoring.py:16-40 — longer queries score higher raw, so shift the sigmoid. */
export function getBm25Params(query: string, lemmatized?: string): [number, number] {
  const lemma = lemmatized ?? lemmatizeForBm25(query);
  const numTerms = lemma ? lemma.split(' ').length : 1;

  if (numTerms <= 3) return [5.0, 0.7];
  if (numTerms <= 6) return [7.0, 0.6];
  if (numTerms <= 9) return [9.0, 0.5];
  if (numTerms <= 15) return [10.0, 0.5];
  return [12.0, 0.5];
}

/** scoring.py:43-54 — logistic sigmoid to [0, 1]. */
export function normalizeBm25(rawScore: number, midpoint: number, steepness: number): number {
  return 1.0 / (1.0 + Math.exp(-steepness * (rawScore - midpoint)));
}

/** scoring.py:60-139 — additive scoring with an adaptive divisor. */
export function scoreAndRank(args: ScoreAndRankArgs): ScoredResult[] {
  const { semanticResults, bm25Scores, entityBoosts, threshold, topK, explain = false } = args;

  const hasBm25 = Object.keys(bm25Scores).length > 0;
  const hasEntity = Object.keys(entityBoosts).length > 0;

  let maxPossible = 1.0;
  if (hasBm25) maxPossible += 1.0;
  if (hasEntity) maxPossible += ENTITY_BOOST_WEIGHT;

  const scored: ScoredResult[] = [];

  for (const result of semanticResults) {
    if (result.id === null || result.id === undefined) continue;

    const semanticScore = result.score || 0.0;
    // Gates the raw semantic score before combining. Upstream behavior: a
    // candidate below threshold is dropped even if BM25/entity would rescue it.
    if (semanticScore < threshold) continue;

    const memIdStr = String(result.id);
    const bm25Score = bm25Scores[memIdStr] ?? 0.0;
    const entityBoost = entityBoosts[memIdStr] ?? 0.0;

    const rawCombined = semanticScore + bm25Score + entityBoost;
    const combined = Math.min(rawCombined / maxPossible, 1.0);

    const scoredResult: ScoredResult = {
      id: memIdStr,
      score: combined,
      payload: result.payload,
    };
    if (explain) {
      scoredResult.score_details = {
        semantic_score: semanticScore,
        bm25_score: bm25Score,
        entity_boost: entityBoost,
        raw_score: rawCombined,
        max_possible_score: maxPossible,
        final_score: combined,
        threshold,
      };
    }
    scored.push(scoredResult);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
