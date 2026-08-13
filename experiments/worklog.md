# Search quality experiment worklog

## Baseline

Captured 2026-08-13 from five locked benchmark runs. Standard deviation is sample
standard deviation.

| Metric | Mean | Std. dev. |
| --- | ---: | ---: |
| `ndcg_at_10` | 0.660586 | 0.000000 |
| `recall_at_5` | 0.575000 | 0.000000 |
| `mrr_at_10` | 0.675000 | 0.000000 |
| `empty_rate` | 0.000000 | 0.000000 |
| `p95_ms` | 0.522725 | 0.087884 |

## Next idea

No experiment has been selected. Record one bounded hypothesis and its gate result
per run, without editing the locked benchmark, metric, or fixture paths.

## Run 1: lexical candidate union

- Candidate commit: `f4588bf824879d5bc3850a4009aaaa556684809e`
- Change measured: union scoped lexical BM25 candidates with semantic KNN candidates
  before hybrid scoring.
- Repetitions: nDCG@10 `0.660586`, `0.660586`, `0.660586`; mean `0.660586`.
- Secondary means: recall@5 `0.575000`, MRR@10 `0.675000`, empty rate `0.000000`,
  p95 `0.485736 ms` (sample std. dev. `0.021783 ms`).
- Correctness gate: pass (`SEARCH_QUALITY_CHECK_RUNNING=1 bash scripts/search-quality-check.sh`,
  exit 0 in an isolated checkout of the candidate commit).
- Decision: **discard**. Delta vs baseline best is `0.000000`; it does not satisfy
  the strict keep rule `delta > noiseFloor` with noise floor `0`.
- Insight: the corrected 96-row locked fixture's rankings do not benefit from adding lexical
  candidates outside semantic KNN under the existing score combiner.
- Cleanup: candidate-only search changes were removed from the production path; the
  production search paths remain restored through `c7bc2bc`.

## Next idea

Choose one bounded ranking hypothesis that can improve ordering on the locked
fixture without changing the benchmark, fixtures, or metrics.
