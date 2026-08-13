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
