# Search quality autoresearch dashboard

## Baseline

| Metric | Mean | Std. dev. |
| --- | ---: | ---: |
| `ndcg_at_10` | 0.660586 | 0.000000 |
| `recall_at_5` | 0.575000 | 0.000000 |
| `mrr_at_10` | 0.675000 | 0.000000 |
| `empty_rate` | 0.000000 | 0.000000 |
| `p95_ms` | 0.522725 | 0.087884 |

## Best

| Metric | Value | Run |
| --- | ---: | ---: |
| `ndcg_at_10` | `0.660586` | baseline |

## Current candidate

| Candidate | Baseline best `ndcg_at_10` | Candidate mean | Delta vs best | Noise floor | Status |
| --- | ---: | ---: | ---: | ---: | --- |
| lexical candidate union (`f4588bf`) | 0.660586 | 0.660586 | 0.000000 | 0.000000 | discard |

The strict rule requires `delta > noiseFloor`; equality at `0.000000` is discarded.

## Runs

| Run | Idea | `ndcg_at_10` | `recall_at_5` | `mrr_at_10` | `empty_rate` | `p95_ms` | Gate |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | lexical candidate union | 0.660586 | 0.575000 | 0.675000 | 0.000000 | 0.485736 | discard (correctness pass; no metric gain) |
