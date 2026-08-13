import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import {
  calculateEmptyRate,
  calculateMrrAtK,
  calculateNdcgAtK,
  calculateRecallAtK,
} from '../src/core/memory/quality-metrics.js';
import { __setEmbeddingConfigForTests, __setModelForTests } from '../src/core/embeddings.js';
import { searchMemories } from '../src/core/memory/search.js';
import { createMemorySchema } from '../src/core/memory/schema.js';
import { insertMemories } from '../src/core/memory/store.js';
import {
  loadSearchQualityFixture,
  type SearchQualityFixture,
  type SearchQualityQuery,
} from './search-quality-fixture.js';

export interface BenchmarkSearchResult {
  id: string;
  score: number;
}

export interface SearchQualityBenchmarkOptions {
  fixture: SearchQualityFixture;
  search: (query: SearchQualityQuery) => Promise<{ results: BenchmarkSearchResult[] }>;
  now?: () => number;
}

export interface SearchQualityBenchmarkOutput {
  ndcgAt10: number;
  recallAt5: number;
  mrrAt10: number;
  emptyRate: number;
  p95Ms: number;
  metricLines: string[];
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nearestRankP95(durations: number[]): number {
  if (durations.length === 0) return 0;
  const sorted = [...durations].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function formatMetric(name: string, value: number): string {
  return `METRIC ${name}=${value.toFixed(6)}`;
}

export async function runSearchQualityBenchmark(
  options: SearchQualityBenchmarkOptions,
): Promise<SearchQualityBenchmarkOutput> {
  const now = options.now ?? performance.now.bind(performance);
  const ndcgAt10: number[] = [];
  const recallAt5: number[] = [];
  const mrrAt10: number[] = [];
  const queryResults: Array<{ resultIds: string[]; relevance: SearchQualityQuery['relevance'] }> = [];
  const durations: number[] = [];

  for (const query of options.fixture.queries) {
    const startedAt = now();
    const { results } = await options.search(query);
    durations.push(now() - startedAt);

    const resultIds = results.map((result) => result.id);
    ndcgAt10.push(calculateNdcgAtK(resultIds, query.relevance, 10));
    recallAt5.push(calculateRecallAtK(resultIds, query.relevance, 5));
    mrrAt10.push(calculateMrrAtK(resultIds, query.relevance, 10));
    queryResults.push({ resultIds, relevance: query.relevance });
  }

  const output = {
    ndcgAt10: average(ndcgAt10),
    recallAt5: average(recallAt5),
    mrrAt10: average(mrrAt10),
    emptyRate: calculateEmptyRate(queryResults),
    p95Ms: nearestRankP95(durations),
  };

  return {
    ...output,
    metricLines: [
      formatMetric('ndcg_at_10', output.ndcgAt10),
      formatMetric('recall_at_5', output.recallAt5),
      formatMetric('mrr_at_10', output.mrrAt10),
      formatMetric('empty_rate', output.emptyRate),
      formatMetric('p95_ms', output.p95Ms),
    ],
  };
}

async function runBenchmarkCommand(): Promise<void> {
  const fixture = await loadSearchQualityFixture();
  const db = new Database(':memory:');
  const queryEmbeddings = new Map(fixture.queries.map((query) => [query.query, query.queryEmbedding]));

  try {
    sqliteVec.load(db);
    createMemorySchema(db);
    insertMemories(db, fixture.corpus);
    __setEmbeddingConfigForTests(() => null);
    __setModelForTests(async () => {}, async (_kind, query) => queryEmbeddings.get(query) ?? null);

    const output = await runSearchQualityBenchmark({
      fixture,
      search: async (query) => searchMemories({
        db,
        query: query.query,
        filters: query.filters,
        limit: 10,
      }),
    });
    console.log(output.metricLines.join('\n'));
  } finally {
    __setModelForTests(null, null);
    __setEmbeddingConfigForTests(null);
    db.close();
  }
}

if (import.meta.main) {
  void runBenchmarkCommand();
}
