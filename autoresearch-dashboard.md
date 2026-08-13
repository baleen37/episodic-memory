# Search quality autoresearch dashboard

## Baseline

| Metric | Mean | Std. dev. |
| --- | ---: | ---: |
| `ndcg_at_10` | 0.623323 | 0.000000 |
| `recall_at_5` | 0.550000 | 0.000000 |
| `mrr_at_10` | 0.625000 | 0.000000 |
| `empty_rate` | 0.000000 | 0.000000 |
| `p95_ms` | 0.460175 | 0.030795 |

## Best

| Metric | Value | Run |
| --- | ---: | ---: |
| `ndcg_at_10` | `0.623323` | baseline |

## Current candidate

| Candidate | Baseline best `ndcg_at_10` | Candidate mean | Delta vs best | Noise floor | Status |
| --- | ---: | ---: | ---: | ---: | --- |
| lexical candidate union (`f4588bf`) | 0.623323 | 0.623323 | 0.000000 | 0.000000 | discard |

The strict rule requires `delta > noiseFloor`; equality at `0.000000` is discarded.

## Runs

| Run | Idea | `ndcg_at_10` | `recall_at_5` | `mrr_at_10` | `empty_rate` | `p95_ms` | Gate |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | lexical candidate union | 0.623323 | 0.550000 | 0.625000 | 0.000000 | 0.556542 | discard (correctness pass; no metric gain) |
