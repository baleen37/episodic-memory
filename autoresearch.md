# Search quality autoresearch

## Objective

Maximize nDCG@10 on the sanitized memmem search fixture.

- Primary metric: `ndcg_at_10`
- Direction: higher
- Budget: `maxRuns: 12`
- Benchmark: `bun run bench:search-quality`

## Correctness gate

Run `bash scripts/search-quality-check.sh` before recording an experiment. It runs
the locked benchmark, the test suite, typecheck, and build in that order.

## Off-limits paths

- `scripts/search-quality-benchmark.ts`
- `scripts/search-quality-benchmark.test.ts`
- `src/core/memory/quality-metrics.ts`
- `src/core/memory/quality-metrics.test.ts`
- `scripts/search-quality-fixture.ts`
- `scripts/search-quality-fixture.test.ts`

## Five-run baseline

Captured 2026-08-13 from `METRIC` lines only. Standard deviation is sample standard
deviation across five runs.

| Metric | Mean | Std. dev. |
| --- | ---: | ---: |
| `ndcg_at_10` | 0.623323 | 0.000000 |
| `recall_at_5` | 0.550000 | 0.000000 |
| `mrr_at_10` | 0.625000 | 0.000000 |
| `empty_rate` | 0.000000 | 0.000000 |
| `p95_ms` | 0.460175 | 0.030795 |
