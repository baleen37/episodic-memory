# Search quality autoresearch

## Objective

Maximize nDCG@10 on the sanitized episodic-memory search fixture.

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
- `tests/fixtures/search-quality-corpus.json`
- `tests/fixtures/search-quality-queries.json`

## Five-run baseline

Captured 2026-08-13 from `METRIC` lines only. Standard deviation is sample standard
deviation across five runs.

| Metric | Mean | Std. dev. |
| --- | ---: | ---: |
| `ndcg_at_10` | 0.660586 | 0.000000 |
| `recall_at_5` | 0.575000 | 0.000000 |
| `mrr_at_10` | 0.675000 | 0.000000 |
| `empty_rate` | 0.000000 | 0.000000 |
| `p95_ms` | 0.522725 | 0.087884 |
