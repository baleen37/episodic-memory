export type RelevanceMap = Record<string, number>;

export interface MetricQueryResult {
  resultIds: string[];
  relevance: RelevanceMap;
}

function limitAtK(k: number): number {
  return Math.max(0, Math.floor(k));
}

function gain(relevance: number): number {
  return 2 ** relevance - 1;
}

function isRelevant(relevance: number | undefined): boolean {
  return relevance !== undefined && relevance >= 2;
}

export function calculateNdcgAtK(resultIds: string[], relevance: RelevanceMap, k: number): number {
  const limit = limitAtK(k);
  const rankedResults = resultIds.slice(0, limit);
  const idealResults = Object.values(relevance).sort((left, right) => right - left).slice(0, limit);

  if (idealResults.length === 0) {
    return 1;
  }

  const discountedGain = (values: number[]): number => values.reduce(
    (total, value, index) => total + gain(value) / Math.log2(index + 2),
    0,
  );
  const actual = discountedGain(rankedResults.map((id) => relevance[id] ?? 0));
  const ideal = discountedGain(idealResults);

  return ideal === 0 ? 1 : actual / ideal;
}

export function calculateRecallAtK(resultIds: string[], relevance: RelevanceMap, k: number): number {
  const relevantIds = new Set(
    Object.entries(relevance)
      .filter(([, value]) => isRelevant(value))
      .map(([id]) => id),
  );

  if (relevantIds.size === 0) {
    return 1;
  }

  const retrievedRelevantIds = new Set(
    resultIds.slice(0, limitAtK(k)).filter((id) => relevantIds.has(id)),
  );
  return retrievedRelevantIds.size / relevantIds.size;
}

export function calculateMrrAtK(resultIds: string[], relevance: RelevanceMap, k: number): number {
  const firstRelevantRank = resultIds
    .slice(0, limitAtK(k))
    .findIndex((id) => isRelevant(relevance[id]));

  return firstRelevantRank === -1 ? 0 : 1 / (firstRelevantRank + 1);
}

export function calculateEmptyRate(queries: MetricQueryResult[]): number {
  const queriesWithRelevantAnswers = queries.filter((query) => (
    Object.values(query.relevance).some((value) => isRelevant(value))
  ));

  if (queriesWithRelevantAnswers.length === 0) {
    return 0;
  }

  const emptyQueries = queriesWithRelevantAnswers.filter((query) => query.resultIds.length === 0);
  return emptyQueries.length / queriesWithRelevantAnswers.length;
}
