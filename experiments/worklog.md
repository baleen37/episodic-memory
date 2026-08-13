# Search quality experiment worklog

## Baseline

Captured 2026-08-13 from five locked benchmark runs. Standard deviation is sample
standard deviation.

| Metric | Mean | Std. dev. |
| --- | ---: | ---: |
| `ndcg_at_10` | 0.623323 | 0.000000 |
| `recall_at_5` | 0.550000 | 0.000000 |
| `mrr_at_10` | 0.625000 | 0.000000 |
| `empty_rate` | 0.000000 | 0.000000 |
| `p95_ms` | 0.460175 | 0.030795 |

## Next idea

No experiment has been selected. Record one bounded hypothesis and its gate result
per run, without editing the locked benchmark, metric, or fixture paths.

## Run 1: lexical candidate union

- Candidate commit: `f4588bf824879d5bc3850a4009aaaa556684809e`
- Change measured: union scoped lexical BM25 candidates with semantic KNN candidates
  before hybrid scoring.
- Repetitions: nDCG@10 `0.623323`, `0.623323`, `0.623323`; mean `0.623323`.
- Secondary means: recall@5 `0.550000`, MRR@10 `0.625000`, empty rate `0.000000`,
  p95 `0.556542 ms`.
- Correctness gate: pass (`bash scripts/search-quality-check.sh`, exit 0 in an
  isolated checkout of the candidate commit).
- Decision: **discard**. Delta vs baseline best is `0.000000`; it does not satisfy
  the strict keep rule `delta > noiseFloor` with noise floor `0`.
- Insight: the locked fixture's rankings do not benefit from adding lexical
  candidates outside semantic KNN under the existing score combiner.
- Cleanup: reverted only Task 5 as `c7bc2bc03a1a710dd4a55a0bc76f7940251b7c38` and
  confirmed the production search paths match `15e0bc3`.

## Next idea

Choose one bounded ranking hypothesis that can improve ordering on the locked
fixture without changing the benchmark, fixtures, or metrics.
