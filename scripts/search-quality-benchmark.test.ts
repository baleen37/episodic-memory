import { describe, expect, test } from 'bun:test';
import { runSearchQualityBenchmark } from './search-quality-benchmark.js';

describe('search quality benchmark', () => {
  test('aggregates one metric value per query and emits the locked names', async () => {
    const output = await runSearchQualityBenchmark({
      search: async query => query.query === 'direct query'
        ? { results: [{ id: 'direct', score: 1 }] }
        : { results: [] },
      fixture: {
        corpus: [],
        queries: [
          {
            query: 'direct query',
            case: 'semantic-only',
            filters: { user_id: 'local' },
            queryEmbedding: Array(384).fill(0),
            relevance: { direct: 3 },
          },
          {
            query: 'empty query',
            case: 'distractor',
            filters: { user_id: 'local' },
            queryEmbedding: Array(384).fill(0),
            relevance: {},
          },
        ],
      },
      now: () => 100,
    });

    expect(output.ndcgAt10).toBeGreaterThanOrEqual(0);
    expect(output.ndcgAt10).toBeLessThanOrEqual(1);
    expect(output.metricLines).toEqual(expect.arrayContaining([
      expect.stringMatching(/^METRIC ndcg_at_10=/),
      expect.stringMatching(/^METRIC recall_at_5=/),
      expect.stringMatching(/^METRIC mrr_at_10=/),
      expect.stringMatching(/^METRIC empty_rate=/),
      expect.stringMatching(/^METRIC p95_ms=/),
    ]));
  });

  test('uses nearest-rank p95 and six decimal metric formatting', async () => {
    const durations = [4, 9, 12];
    let elapsed = 0;
    const output = await runSearchQualityBenchmark({
      fixture: {
        corpus: [],
        queries: durations.map((_, index) => ({
          query: `query ${index + 1}`,
          case: 'semantic-only' as const,
          filters: { user_id: 'local' },
          queryEmbedding: Array(384).fill(0),
          relevance: { direct: 3 },
        })),
      },
      search: async query => {
        elapsed += durations[Number(query.query.at(-1)) - 1];
        return { results: [{ id: 'direct', score: 1 }] };
      },
      now: () => elapsed,
    });

    expect(output.p95Ms).toBe(12);
    expect(output.metricLines).toEqual([
      'METRIC ndcg_at_10=1.000000',
      'METRIC recall_at_5=1.000000',
      'METRIC mrr_at_10=1.000000',
      'METRIC empty_rate=0.000000',
      'METRIC p95_ms=12.000000',
    ]);
  });
});
