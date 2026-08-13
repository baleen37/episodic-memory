# Search Quality Autoresearch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a privacy-safe, locked search-quality benchmark and test the first hybrid-retrieval improvement against it, keeping only changes that improve `nDCG@10` without correctness regressions.

**Architecture:** Keep `searchMemories()` and the MCP/CLI API unchanged. Add pure ranking metrics and a deterministic in-memory benchmark around the existing search core, then extend candidate generation so FTS5 lexical candidates can be ranked even when they fall outside the semantic KNN candidate set. The benchmark and correctness scripts remain outside the production runtime path and are locked during experiments.

**Tech Stack:** Bun, TypeScript, `bun:test`, `bun:sqlite`, `sqlite-vec`, JSON fixtures, Bash, Git.

## Global Constraints

- Use Bun for all tests, scripts, builds, and SQLite access.
- Do not copy production conversation text, metadata, IDs, or query logs into committed fixtures.
- Keep the public `searchMemories`, CLI, and MCP input/output contracts unchanged.
- Write a failing test before every production behavior change.
- Do not add runtime dependencies.
- Do not edit the benchmark, metric code, or fixture files during search experiments after baseline capture.
- One search lever per experiment; record every result in the autoresearch worklog.
- Keep metadata scope filtering fail-closed for both semantic and lexical candidates.
- Preserve the current score range `[0, 1]` and `explain` response shape.

---

### Task 1: Add pure ranking-quality metrics

**Files:**
- Create: `src/core/memory/quality-metrics.ts`
- Test: `src/core/memory/quality-metrics.test.ts`

**Interfaces:**
- Consumes: ordered result IDs and a `Record<string, number>` of graded relevance labels.
- Produces: `calculateNdcgAtK`, `calculateRecallAtK`, `calculateMrrAtK`, and `calculateEmptyRate` functions used by the benchmark.

- [ ] **Step 1: Write the failing metric tests**

Create tests with exact expected values:

```ts
import { describe, expect, test } from 'bun:test';
import {
  calculateEmptyRate,
  calculateMrrAtK,
  calculateNdcgAtK,
  calculateRecallAtK,
} from './quality-metrics.js';

describe('search quality metrics', () => {
  test('nDCG rewards the ideal graded ordering', () => {
    const relevance = { direct: 3, partial: 2, context: 1 };
    expect(calculateNdcgAtK(['direct', 'partial', 'context'], relevance, 3)).toBeCloseTo(1, 10);
  });

  test('nDCG discounts a relevant result that appears later', () => {
    const relevance = { direct: 3, partial: 2 };
    const ideal = calculateNdcgAtK(['direct', 'partial'], relevance, 2);
    const late = calculateNdcgAtK(['noise', 'partial', 'direct'], relevance, 3);
    expect(ideal).toBeGreaterThan(late);
  });

  test('recall counts only relevance two or higher', () => {
    const relevance = { direct: 3, partial: 2, context: 1 };
    expect(calculateRecallAtK(['context', 'partial'], relevance, 2)).toBeCloseTo(1 / 2, 10);
  });

  test('MRR returns the reciprocal rank of the first relevant result', () => {
    const relevance = { direct: 3, partial: 2 };
    expect(calculateMrrAtK(['noise', 'partial', 'direct'], relevance, 3)).toBeCloseTo(0.5, 10);
    expect(calculateMrrAtK(['noise'], relevance, 1)).toBe(0);
  });

  test('empty rate counts queries with known relevant answers and no results', () => {
    expect(calculateEmptyRate([
      { resultIds: [], relevance: { direct: 3 } },
      { resultIds: ['direct'], relevance: { direct: 3 } },
      { resultIds: [], relevance: { context: 1 } },
    ])).toBeCloseTo(1 / 2, 10);
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bun test src/core/memory/quality-metrics.test.ts`

Expected: FAIL because `quality-metrics.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal metric functions**

Implement these exact signatures:

```ts
export type RelevanceMap = Record<string, number>;

export interface MetricQueryResult {
  resultIds: string[];
  relevance: RelevanceMap;
}

export function calculateNdcgAtK(resultIds: string[], relevance: RelevanceMap, k: number): number;
export function calculateRecallAtK(resultIds: string[], relevance: RelevanceMap, k: number): number;
export function calculateMrrAtK(resultIds: string[], relevance: RelevanceMap, k: number): number;
export function calculateEmptyRate(queries: MetricQueryResult[]): number;
```

Use gain `2^relevance - 1`, logarithmic discount `log2(rank + 2)`, and relevance `>= 2` as the binary retrieval threshold. For an empty ideal list, return `1` for nDCG so a query with no graded answer does not penalize the aggregate. For recall with no relevant IDs, return `1` only when the query has no relevant IDs; this keeps the metric neutral for intentionally negative queries. For MRR with no hit, return `0`. Clamp `k` to a non-negative integer at the function boundary.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `bun test src/core/memory/quality-metrics.test.ts`

Expected: PASS with all metric tests green.

- [ ] **Step 5: Run the existing memory tests**

Run: `bun test src/core/memory/scoring.test.ts src/core/memory/search.test.ts`

Expected: PASS; this task must not change existing search behavior.

- [ ] **Step 6: Commit the metric helper**

```bash
git add src/core/memory/quality-metrics.ts src/core/memory/quality-metrics.test.ts
git commit -m "test(search): add ranking quality metrics"
```

### Task 2: Add sanitized benchmark fixtures and validation

**Files:**
- Create: `tests/fixtures/search-quality-corpus.json`
- Create: `tests/fixtures/search-quality-queries.json`
- Create: `scripts/search-quality-fixture.ts`
- Test: `scripts/search-quality-fixture.test.ts`

**Interfaces:**
- Consumes: no production database or transcript files.
- Produces: typed `SearchQualityCorpusRow[]` and `SearchQualityQuery[]` with fixed 384-dimensional vectors and graded judgments.

- [ ] **Step 1: Write the failing fixture validation tests**

Test that the loader rejects malformed data and accepts the complete fixture:

```ts
test('loads a non-empty sanitized corpus with valid 384-dimensional vectors', async () => {
  const fixture = await loadSearchQualityFixture();
  expect(fixture.corpus.length).toBeGreaterThanOrEqual(20);
  expect(fixture.queries.length).toBeGreaterThanOrEqual(40);
  expect(fixture.corpus.every(row => row.embedding.length === 384)).toBe(true);
  expect(fixture.queries.every(query => query.query.length > 0)).toBe(true);
});

test('every query judgment references a corpus row in the same scope', async () => {
  const fixture = await loadSearchQualityFixture();
  const ids = new Set(fixture.corpus.map(row => row.id));
  for (const query of fixture.queries) {
    for (const id of Object.keys(query.relevance)) expect(ids.has(id)).toBe(true);
  }
});

test('fixture corpus contains all required retrieval cases', async () => {
  const fixture = await loadSearchQualityFixture();
  expect(fixture.queries.filter(q => q.case === 'cross-lingual').length).toBeGreaterThanOrEqual(5);
  expect(fixture.queries.filter(q => q.case === 'rare-token').length).toBeGreaterThanOrEqual(5);
  expect(fixture.queries.filter(q => q.case === 'partial-match').length).toBeGreaterThanOrEqual(5);
  expect(fixture.queries.filter(q => q.case === 'distractor').length).toBeGreaterThanOrEqual(5);
  expect(fixture.queries.filter(q => q.case === 'scope').length).toBeGreaterThanOrEqual(5);
  expect(fixture.queries.filter(q => q.case === 'recency').length).toBeGreaterThanOrEqual(5);
  expect(fixture.queries.filter(q => q.case === 'semantic-only').length).toBeGreaterThanOrEqual(5);
  expect(fixture.queries.filter(q => q.case === 'lexical-only').length).toBeGreaterThanOrEqual(5);
});
```

- [ ] **Step 2: Run the fixture tests to verify they fail**

Run: `bun test scripts/search-quality-fixture.test.ts`

Expected: FAIL because the fixture files and loader do not exist.

- [ ] **Step 3: Create the fixed sanitized corpus**

Use 24 signal rows with IDs `memory-001` through `memory-024` plus 72 deterministic distractor rows with IDs `distractor-001` through `distractor-072`. Split signal rows into four scopes: `local`, `team-alpha`, `team-beta`, and `archived`. Each row must include `id`, `memory`, `metadata.user_id`, and a deterministic unit vector with 384 values. Use the first two vector slots for the benchmark direction and fill the remaining 382 slots with zeroes. Keep the text synthetic and use these themes:

- memmem indexing, hybrid ranking, sqlite-vec, FTS5, BM25, and embedding batch work
- project and tool names such as `Orchid`, `Harbor`, `Cedar`, `Quartz`, `Lumen`, and `Northstar`
- stale/current pairs where the current row has a later `updated_at`
- scope duplicates whose text is identical but whose `user_id` differs
- lexical-only rows containing a rare token that is deliberately assigned a distant vector

Use fixed angles `0`, `0.25`, `0.5`, `0.75`, `1.0`, `1.25`, `1.5`, `1.75`, `2.0`, and `3.0` radians for the first two vector slots. Do not include personal names, filesystem paths, API keys, transcript excerpts, or real production IDs.

- [ ] **Step 4: Create the 40-query judgment set**

Create exactly five queries for each of these eight case labels: `cross-lingual`, `rare-token`, `partial-match`, `distractor`, `scope`, `recency`, `semantic-only`, and `lexical-only`. Each query must contain `query`, `case`, `filters`, `queryEmbedding`, and `relevance`. Give direct answers relevance `3`, supporting rows `2`, context rows `1`, and all out-of-scope or distractor rows an omitted relevance entry. At least five queries must have an empty expected result inside their scope, and at least five must have a relevance-3 row that is not among the 60 closest semantic rows after the benchmark adds distractors.

The fixture loader must reject duplicate IDs, vectors with a dimension other than 384, relevance values outside `1..3`, missing `user_id` scope, and judgment IDs absent from the corpus.

- [ ] **Step 5: Implement the typed loader**

Export:

```ts
export interface SearchQualityCorpusRow {
  id: string;
  memory: string;
  metadata: { user_id: string; agent_id?: string; run_id?: string; updated_at?: number };
  embedding: number[];
}

export interface SearchQualityQuery {
  query: string;
  case: 'cross-lingual' | 'rare-token' | 'partial-match' | 'distractor' | 'scope' | 'recency' | 'semantic-only' | 'lexical-only';
  filters: { user_id: string };
  queryEmbedding: number[];
  relevance: Record<string, 1 | 2 | 3>;
}

export interface SearchQualityFixture {
  corpus: SearchQualityCorpusRow[];
  queries: SearchQualityQuery[];
}

export async function loadSearchQualityFixture(): Promise<SearchQualityFixture>;
```

Load JSON relative to the repository root using `import.meta.dir`, validate every invariant above, and throw an error naming the invalid row or query. Do not fall back to the production database.

- [ ] **Step 6: Run the fixture tests to verify they pass**

Run: `bun test scripts/search-quality-fixture.test.ts`

Expected: PASS with all fixture validation tests green.

- [ ] **Step 7: Commit the locked fixture**

```bash
git add tests/fixtures/search-quality-corpus.json tests/fixtures/search-quality-queries.json scripts/search-quality-fixture.ts scripts/search-quality-fixture.test.ts
git commit -m "test(search): add sanitized quality benchmark fixtures"
```

### Task 3: Add the locked benchmark command

**Files:**
- Create: `scripts/search-quality-benchmark.ts`
- Test: `scripts/search-quality-benchmark.test.ts`
- Modify: `package.json: scripts`

**Interfaces:**
- Consumes: `loadSearchQualityFixture()` and `searchMemories()` against an in-memory SQLite database.
- Produces: stdout lines `METRIC ndcg_at_10=...`, `METRIC recall_at_5=...`, `METRIC mrr_at_10=...`, `METRIC empty_rate=...`, and `METRIC p95_ms=...`.

- [ ] **Step 1: Write the failing benchmark contract tests**

Test the pure runner with an injected search function so the output contract is deterministic:

```ts
test('benchmark aggregates one metric value per query and emits the locked names', async () => {
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
```

- [ ] **Step 2: Run the benchmark contract test to verify it fails**

Run: `bun test scripts/search-quality-benchmark.test.ts`

Expected: FAIL because the runner and metric output types do not exist.

- [ ] **Step 3: Implement the deterministic runner**

Export:

```ts
export interface BenchmarkSearchResult { id: string; score: number }
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
export async function runSearchQualityBenchmark(
  options: SearchQualityBenchmarkOptions,
): Promise<SearchQualityBenchmarkOutput>;
```

Run queries in fixture order, measure each search with `performance.now()` unless `now` is injected, pass returned IDs to the metric helpers, average each quality metric across all queries, and compute p95 by sorting per-query durations with nearest-rank indexing. Format all metric values with six decimal places. Never print memory text or metadata.

- [ ] **Step 4: Wire the real in-memory search path**

The CLI entry point must create `new Database(':memory:')`, load `sqliteVec`, call `createMemorySchema`, insert every corpus row with `insertMemories`, and override the embedding model so each query returns its fixture `queryEmbedding`. Invoke `searchMemories` with `limit: 10`, the query’s `filters`, and default threshold behavior. Restore model overrides and close the database in a `finally` block.

Add `"bench:search-quality": "bun scripts/search-quality-benchmark.ts"` to `package.json`.

- [ ] **Step 5: Run the contract and real benchmark tests**

Run: `bun test scripts/search-quality-benchmark.test.ts && bun run bench:search-quality`

Expected: PASS, followed by all five `METRIC` lines. The benchmark must not open or mutate `~/.config/memmem`.

- [ ] **Step 6: Commit the benchmark harness**

```bash
git add scripts/search-quality-benchmark.ts scripts/search-quality-benchmark.test.ts package.json
git commit -m "test(search): add locked quality benchmark"
```

### Task 4: Add benchmark correctness gates and baseline artifacts

**Files:**
- Create: `scripts/search-quality-check.sh`
- Test: `scripts/search-quality-check.test.ts`
- Create: `autoresearch.md`
- Create: `experiments/worklog.md`
- Create: `autoresearch-dashboard.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: the locked benchmark command and repository test/build commands.
- Produces: a non-zero exit code for any correctness or quality harness failure, plus autoresearch state files for bounded experiments.

- [ ] **Step 1: Write the failing shell gate test**

Create `scripts/search-quality-check.test.ts` that runs the check script with `Bun.spawn`, asserts exit code `0`, and asserts stdout contains `benchmark`, `tests`, `typecheck`, and `build` status lines. Scope, duplicate, score-range, and crash regressions are covered by the existing search and MCP test suites invoked by the gate.

- [ ] **Step 2: Run the gate test to verify it fails**

Run: `bun test scripts/search-quality-check.test.ts`

Expected: FAIL because the check script does not exist.

- [ ] **Step 3: Implement the check script**

Use `#!/usr/bin/env bash` and `set -euo pipefail`. Run, in order:

```bash
bun run bench:search-quality
bun test
bun run typecheck
bun run build
```

Print one status line before each command and exit on the first failure. The script must not call `memmem sync`, read the production database, or modify benchmark fixture files.

- [ ] **Step 4: Add bounded autoresearch state**

Create `autoresearch.md` with objective `maximize nDCG@10 on the sanitized memmem search fixture`, primary metric `ndcg_at_10`, direction `higher`, budget `maxRuns: 12`, and explicit off-limits paths for the benchmark, metric code, and fixtures. Create `experiments/worklog.md` with baseline and next-idea sections, and `autoresearch-dashboard.md` with baseline/best/run table headers. Add only these exact runtime-generated paths to `.gitignore`: `autoresearch.jsonl`, `.autoresearch-off`, and `autoresearch.ideas.md`.

- [ ] **Step 5: Capture and record the baseline**

Run the locked benchmark five times:

```bash
for i in 1 2 3 4 5; do bun run bench:search-quality > "/tmp/memmem-search-quality-baseline-$i.txt"; done
```

Parse only the `METRIC` lines. Record the mean and standard deviation of `ndcg_at_10`, `recall_at_5`, `mrr_at_10`, `empty_rate`, and `p95_ms` in `autoresearch.md`, `experiments/worklog.md`, and the config header in `autoresearch.jsonl`. Do not copy full benchmark output into the repository.

- [ ] **Step 6: Run the gate and confirm the baseline**

Run: `bun test scripts/search-quality-check.test.ts && bash scripts/search-quality-check.sh`

Expected: PASS, with baseline metrics recorded and no production database access.

- [ ] **Step 7: Commit the harness and baseline documentation**

```bash
git add scripts/search-quality-check.sh scripts/search-quality-check.test.ts autoresearch.md experiments/worklog.md autoresearch-dashboard.md .gitignore
git commit -m "test(search): lock quality experiment harness"
```

### Task 5: Add a failing regression test for lexical candidates outside semantic KNN

**Files:**
- Modify: `src/core/memory/scoring.ts`
- Test: `src/core/memory/scoring.test.ts`
- Modify: `src/core/memory/search.ts`
- Test: `src/core/memory/search.test.ts`

**Interfaces:**
- Consumes: existing `Candidate`, `scoreAndRank`, FTS5, sqlite-vec, and metadata filter APIs.
- Produces: the same `SearchResultItem` shape, with FTS-only candidates eligible for ranking when they have a positive BM25 score.

- [ ] **Step 1: Add the scoring regression test**

Extend `Candidate` in the test helper with an explicit semantic-presence flag and add:

```ts
test('allows a positive BM25-only candidate through the semantic threshold gate', () => {
  const out = scoreAndRank({
    semanticResults: [{ id: 'lexical', score: 0, hasSemanticScore: false, payload: { data: 'lexical' } }],
    bm25Scores: { lexical: 0.9 },
    entityBoosts: {},
    threshold: 0.1,
    topK: 10,
  });
  expect(out.map(result => result.id)).toEqual(['lexical']);
});
```

Keep the existing `threshold gates raw semantic BEFORE combining` test unchanged to prove ordinary semantic candidates retain their current behavior.

- [ ] **Step 2: Run the scoring test to verify it fails**

Run: `bun test src/core/memory/scoring.test.ts`

Expected: FAIL because `Candidate` has no semantic-presence field and the existing threshold gate drops the BM25-only row.

- [ ] **Step 3: Add the search regression fixture**

Add a test that inserts:

- 80 `user_id: 'local'` distractor memories whose vectors are closer to the query than the target and whose text does not contain `rareorchidtoken`.
- 200 filler memories under `user_id: 'local'` so FTS5 BM25 produces a positive rare-term score.
- One target memory with text `The Orchid deployment uses rareorchidtoken for lexical retrieval`, vector `vec(3.0)`, and `user_id: 'local'`.
- One same-text distractor with `user_id: 'someone-else'`.

Use the existing deterministic vector helper and model override so query `rareorchidtoken` maps to the distractor direction. Search with `{ user_id: 'local' }`, `limit: 1`, and `explain: true`. Assert the local target is returned, its `semantic_score` is `0`, and its `bm25_score` is greater than `0`. Assert the other-user row is never returned.

- [ ] **Step 4: Run the search regression test to verify it fails**

Run: `bun test src/core/memory/search.test.ts`

Expected: FAIL because current BM25 rows are discarded unless their rowids are already present in the semantic candidate map.

- [ ] **Step 5: Implement the minimal candidate union**

Change `Candidate` to include `hasSemanticScore?: boolean`, defaulting to `true` for existing callers. In `scoreAndRank`, keep the current threshold gate for ordinary semantic rows. Permit a row with `hasSemanticScore === false` only when its BM25 score is positive. Keep the current adaptive divisor and score-details fields unchanged.

In `searchMemories`:

1. Keep the existing widening KNN query and semantic row map.
2. Change the FTS query to join `fts_memories` to `memories`, apply the same `filterClause` and `params`, and return memory payload plus `rowid` and raw BM25 score.
3. Build a union map keyed by rowid. Semantic rows get `score: 1 - distance` and `hasSemanticScore: true`; FTS-only rows get `score: 0` and `hasSemanticScore: false`.
4. Normalize every positive FTS raw score and store it by memory ID, including FTS-only rows.
5. Pass the union candidates into `scoreAndRank` and preserve result conversion, metadata promotion, topK, threshold, and `explain` behavior.

The FTS SQL must apply metadata filters before rows enter the union. Do not loosen `assertScoped` or add a second unscoped query.

- [ ] **Step 6: Run focused tests to verify the change passes**

Run: `bun test src/core/memory/scoring.test.ts src/core/memory/search.test.ts`

Expected: PASS, including the new lexical-only regression and all existing threshold, scope, BM25, and KNN-widening tests.

- [ ] **Step 7: Commit the candidate-recall change**

```bash
git add src/core/memory/scoring.ts src/core/memory/scoring.test.ts src/core/memory/search.ts src/core/memory/search.test.ts
git commit -m "fix(search): rank lexical candidates outside semantic top-k"
```

### Task 6: Run the first autoresearch experiment and decide keep/discard

**Files:**
- Modify: `experiments/worklog.md`
- Modify: `autoresearch-dashboard.md`
- Modify: `autoresearch.jsonl`
- Potentially revert: only the Task 5 production files if the experiment fails

**Interfaces:**
- Consumes: the locked benchmark, correctness gate, and Task 5 candidate-union implementation.
- Produces: a recorded `keep` or `discard` result with metric deltas and a clean branch state.

- [ ] **Step 1: Run the candidate-union benchmark three times**

Run:

```bash
for i in 1 2 3; do bun run bench:search-quality > "/tmp/memmem-search-quality-candidate-union-$i.txt"; done
```

Parse only `METRIC` lines and compute the mean `ndcg_at_10`. Keep `recall_at_5`, `mrr_at_10`, `empty_rate`, and `p95_ms` as secondary observations.

- [ ] **Step 2: Apply the keep/discard rule**

Mark the experiment `keep` only when:

```text
candidate_mean_ndcg_at_10 - baseline_best_ndcg_at_10 > noiseFloor
```

and `bash scripts/search-quality-check.sh` exits `0`. If the delta is within the noise floor, the score is lower, or any correctness gate fails, mark it `discard`.

- [ ] **Step 3: Record the experiment**

Append a JSONL result with `run`, current commit, metric, status, description, `op: "draft"`, `parent: null`, timestamp, and all secondary metrics. Update the dashboard with the baseline, candidate result, delta vs best, noise-floor comparison, and status. Add a worklog entry containing what changed, metric values, insight, and the next experiment.

- [ ] **Step 4: Revert a losing experiment safely**

If discarded, revert only the Task 5 commit with:

```bash
git revert --no-edit HEAD
```

Do not delete benchmark state or use `git clean -fdx`. Re-run `bun run bench:search-quality` and `bash scripts/search-quality-check.sh` to prove the baseline is restored.

- [ ] **Step 5: Run the full verification suite**

Run:

```bash
bun test
bun run typecheck
bun run build
bun run compat:check
./bin/memmem search "hybrid memory search" --limit 3
```

Expected: all tests and checks pass, build artifacts are current, CLI search returns at most three scoped results, and no production index content is written by the benchmark.

- [ ] **Step 6: Commit the final experiment record**

If the candidate union is kept:

```bash
git add autoresearch.jsonl autoresearch.md experiments/worklog.md autoresearch-dashboard.md
git commit -m "perf(search): record lexical candidate quality experiment"
```

If it is discarded, commit only the updated worklog/dashboard state after the revert with:

```bash
git add autoresearch.jsonl autoresearch.md experiments/worklog.md autoresearch-dashboard.md
git commit -m "test(search): record lexical candidate experiment"
```

### Task 7: Live MCP smoke verification and handoff

**Files:**
- No production source changes.

**Interfaces:**
- Consumes: the built MCP server and the configured local memmem MCP connection.
- Produces: runtime evidence that the search tool remains callable and scoped.

- [ ] **Step 1: Verify the local CLI health surface**

Run: `./bin/memmem doctor`

Expected: `✓ build`, `✓ index`, and `✓ data`.

- [ ] **Step 2: Call the live MCP search tool**

Call the configured memmem search tool with a short, non-sensitive query, `limit: 3`, and `explain: true`. Verify the call returns valid JSON, no duplicate IDs, scores in `[0, 1]`, and only local-scope records.

- [ ] **Step 3: Report the evidence**

Report baseline and candidate quality metrics, whether the candidate was kept or discarded, full verification commands, live doctor result, MCP call result, changed files, and any remaining quality gaps. Do not include memory text from the production index in the report.
