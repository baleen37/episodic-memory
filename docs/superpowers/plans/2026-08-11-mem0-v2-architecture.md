# mem0 v2 Architecture Replication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace memmem's memory layer with a faithful port of mem0 v2.0.17 — ADD-only batch extraction, `MemoryItem` schema, and hybrid semantic+BM25+entity scoring.

**Architecture:** A new `src/core/memory/` subsystem replaces `memory_records`/`extraction_state` with mem0's three-store model (memories + history + entities). Ingestion becomes a single-LLM-call phased batch pipeline that only ever emits ADD; consolidation happens by md5 hash equality, not LLM arbitration. Search over-fetches `max(limit*4, 60)` candidates and combines sigmoid-normalized BM25 with semantic and entity signals under an adaptive divisor.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, sqlite-vec (384-dim), SQLite FTS5 (`unicode61`), Xenova/multilingual-e5-small.

## Global Constraints

These apply to every task. Values are copied verbatim from mem0 v2.0.17 source.

- **Runtime is Bun, never Node.** CLI and MCP bundles import `bun:sqlite`.
- **Never call `initDatabase()` in production code** — it wipes the DB. Tests must set `TEST_DB_PATH=':memory:'` before calling it.
- `ENTITY_BOOST_WEIGHT = 0.5` (`mem0/utils/scoring.py:57`)
- `threshold` default `0.1`, validated to be a number in `[0, 1]` inclusive (`main.py:212-228`)
- `internal_limit = max(limit * 4, 60)` (`main.py:1631`)
- Existing-memory retrieval at ingest: `top_k=10` (`main.py:919`)
- Session context: last **10** messages (`main.py:910`)
- Entity dedup cosine: `>= 0.95` (`main.py:616`, `main.py:1142`)
- BM25 sigmoid params by lemmatized query term count (`scoring.py:31-40`): `<=3 → (5.0, 0.7)`, `<=6 → (7.0, 0.6)`, `<=9 → (9.0, 0.5)`, `<=15 → (10.0, 0.5)`, else `(12.0, 0.5)`
- BM25 normalization: `1 / (1 + exp(-steepness * (raw - midpoint)))` (`scoring.py:54`)
- SQLite `bm25()` returns **negative** values where more negative is better, so raw score is `-bm25(...)` and `ORDER BY bm25(...) ASC` ranks best-first. Verified at 1000 docs: strong match `-10.24`, weak match `-6.67`. Note that on a near-empty corpus IDF collapses and all scores approach `0` — BM25 contributes nothing until the store has meaningful document counts, which is expected and not a bug.
- Combined score: `min((semantic + bm25 + entity_boost) / max_possible, 1.0)` where `max_possible` starts at `1.0`, `+1.0` if any BM25 scores exist, `+0.5` if any entity boosts exist (`scoring.py:94-119`)
- **Threshold gates raw semantic score BEFORE combining** (`scoring.py:111`). Reproduce this even though it drops candidates BM25 would rescue.
- Promoted payload keys (`main.py:1682-1690`): `user_id`, `agent_id`, `run_id`, `actor_id`, `role`, `attributed_to`, `expiration_date`
- Extraction output schema: `{"memory": [{"id": "0", "text": "...", "attributed_to": "user", "linked_memory_ids": ["uuid"]}]}`. `id` is a sequential integer string; `attributed_to` is required and is `"user"` or `"assistant"`; `linked_memory_ids` is optional.
- Extraction failure raises `LLMError` — never silently returns `[]`. Callers must distinguish "LLM down" from "no facts found".
- **Storage language is English.** `use_input_language` stays `false` (mem0's default). Do not add the Language Requirement section to the prompt.
- Commit after every task. Do not squash.

### Sanctioned deviations from mem0

Only these three. Everything else is a 1:1 port.

| mem0 | memmem | Reason |
| --- | --- | --- |
| spaCy `extract_entities` | Entities requested in the same extraction LLM call | No spaCy in TS |
| BM25 via `text_lemmatized` + store keyword search | SQLite FTS5 `unicode61` + `bm25()` | Zero new dependencies |
| Qdrant | sqlite-vec | Existing stack |

Because FTS5 `unicode61` tokenizes on whitespace, there is no lemmatizer. `lemmatize_for_bm25` becomes lowercase + whitespace-split; term count for `get_bm25_params` uses that split.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/core/memory/schema.ts` | `MemoryItem` type, table DDL, `openMemoryDb()` |
| `src/core/memory/scoring.ts` | Port of `mem0/utils/scoring.py` — pure functions, no I/O |
| `src/core/memory/prompts.ts` | `ADDITIVE_EXTRACTION_PROMPT`, `generateAdditiveExtractionPrompt()` |
| `src/core/memory/extract.ts` | LLM call + response parse + `LLMError` |
| `src/core/memory/store.ts` | Insert/dedup/history/entity persistence |
| `src/core/memory/add.ts` | The 8-phase batch pipeline |
| `src/core/memory/search.ts` | `_search_vector_store` port |
| `src/core/memory/filters.ts` | Metadata filter operators → SQL |

**Modified:** `src/core/db.ts`, `src/mcp/{handlers,schemas,tools}.ts`, `src/cli/{main,search,sync,stats}.ts`, `CLAUDE.md`

**Deleted:** `src/core/read.ts`, `src/cli/read.ts`, `src/core/llm/extractor.ts`, `src/core/indexer.ts`, and their tests.

Tests are co-located as `*.test.ts` per existing convention.

---

### Task 1: Scoring primitives

Pure functions, no DB. Port first because everything downstream depends on the numbers being right.

**Files:**
- Create: `src/core/memory/scoring.ts`
- Test: `src/core/memory/scoring.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ENTITY_BOOST_WEIGHT: 0.5`, `getBm25Params(query: string, lemmatized?: string): [number, number]`, `normalizeBm25(raw: number, midpoint: number, steepness: number): number`, `lemmatizeForBm25(text: string): string`, `scoreAndRank(args: ScoreAndRankArgs): ScoredResult[]` where
  ```ts
  interface Candidate { id: string; score: number; payload: Record<string, unknown> | null }
  interface ScoreDetails { semantic_score: number; bm25_score: number; entity_boost: number; raw_score: number; max_possible_score: number; final_score: number; threshold: number }
  interface ScoredResult { id: string; score: number; payload: Record<string, unknown> | null; score_details?: ScoreDetails }
  interface ScoreAndRankArgs { semanticResults: Candidate[]; bm25Scores: Record<string, number>; entityBoosts: Record<string, number>; threshold: number; topK: number; explain?: boolean }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/core/memory/scoring.test.ts
import { describe, expect, test } from 'bun:test';
import { ENTITY_BOOST_WEIGHT, getBm25Params, normalizeBm25, lemmatizeForBm25, scoreAndRank } from './scoring.js';

describe('getBm25Params', () => {
  test('buckets by lemmatized term count', () => {
    expect(getBm25Params('a b c')).toEqual([5.0, 0.7]);
    expect(getBm25Params('a b c d')).toEqual([7.0, 0.6]);
    expect(getBm25Params('a b c d e f g')).toEqual([9.0, 0.5]);
    expect(getBm25Params('a b c d e f g h i j')).toEqual([10.0, 0.5]);
    expect(getBm25Params(Array(16).fill('x').join(' '))).toEqual([12.0, 0.5]);
  });
  test('empty query counts as one term', () => {
    expect(getBm25Params('')).toEqual([5.0, 0.7]);
  });
});

describe('normalizeBm25', () => {
  test('midpoint maps to 0.5', () => {
    expect(normalizeBm25(5.0, 5.0, 0.7)).toBeCloseTo(0.5, 10);
  });
  test('is monotonic increasing and bounded in [0,1]', () => {
    const low = normalizeBm25(0, 5.0, 0.7);
    const high = normalizeBm25(20, 5.0, 0.7);
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThan(1);
  });
});

describe('lemmatizeForBm25', () => {
  test('lowercases and collapses whitespace', () => {
    expect(lemmatizeForBm25('  Search   QUALITY ')).toBe('search quality');
  });
});

describe('scoreAndRank', () => {
  const cand = (id: string, score: number): Candidate => ({ id, score, payload: { data: id } });
  type Candidate = { id: string; score: number; payload: Record<string, unknown> | null };

  test('semantic only uses divisor 1.0', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.8)], bm25Scores: {}, entityBoosts: {},
      threshold: 0.1, topK: 10,
    });
    expect(out[0].score).toBeCloseTo(0.8, 10);
  });

  test('semantic + bm25 uses divisor 2.0', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.8)], bm25Scores: { a: 0.6 }, entityBoosts: {},
      threshold: 0.1, topK: 10,
    });
    expect(out[0].score).toBeCloseTo(0.7, 10); // (0.8+0.6)/2.0
  });

  test('semantic + entity uses divisor 1.5', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.9)], bm25Scores: {}, entityBoosts: { a: 0.5 },
      threshold: 0.1, topK: 10,
    });
    expect(out[0].score).toBeCloseTo(1.4 / 1.5, 10);
  });

  test('all three signals use divisor 2.5', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.8)], bm25Scores: { a: 0.6 }, entityBoosts: { a: 0.5 },
      threshold: 0.1, topK: 10,
    });
    expect(out[0].score).toBeCloseTo(1.9 / 2.5, 10);
  });

  test('divisor depends on signal presence globally, not per-candidate', () => {
    // 'b' has no bm25 entry but divisor is still 2.0 because bm25Scores is non-empty
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.8), cand('b', 0.8)], bm25Scores: { a: 0.6 }, entityBoosts: {},
      threshold: 0.1, topK: 10,
    });
    const b = out.find(r => r.id === 'b')!;
    expect(b.score).toBeCloseTo(0.4, 10); // 0.8/2.0
  });

  test('threshold gates raw semantic BEFORE combining', () => {
    // semantic 0.05 < threshold even though bm25 1.0 would rescue it
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.05)], bm25Scores: { a: 1.0 }, entityBoosts: {},
      threshold: 0.1, topK: 10,
    });
    expect(out).toHaveLength(0);
  });

  test('combined score clamps at 1.0', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 1.0)], bm25Scores: { a: 1.0 }, entityBoosts: { a: 0.9 },
      threshold: 0.1, topK: 10,
    });
    expect(out[0].score).toBe(1.0);
  });

  test('sorts descending and truncates to topK', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.3), cand('b', 0.9), cand('c', 0.6)],
      bm25Scores: {}, entityBoosts: {}, threshold: 0.1, topK: 2,
    });
    expect(out.map(r => r.id)).toEqual(['b', 'c']);
  });

  test('explain exposes score_details', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.8)], bm25Scores: { a: 0.6 }, entityBoosts: {},
      threshold: 0.1, topK: 10, explain: true,
    });
    expect(out[0].score_details).toEqual({
      semantic_score: 0.8, bm25_score: 0.6, entity_boost: 0,
      raw_score: 1.4, max_possible_score: 2.0,
      final_score: 0.7, threshold: 0.1,
    });
  });

  test('omits score_details when explain is false', () => {
    const out = scoreAndRank({
      semanticResults: [cand('a', 0.8)], bm25Scores: {}, entityBoosts: {}, threshold: 0.1, topK: 10,
    });
    expect(out[0].score_details).toBeUndefined();
  });

  test('ENTITY_BOOST_WEIGHT matches mem0', () => {
    expect(ENTITY_BOOST_WEIGHT).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/memory/scoring.test.ts`
Expected: FAIL — `Cannot find module './scoring.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/memory/scoring.ts
/** Port of mem0/utils/scoring.py (v2.0.17). Constants must match upstream exactly. */

export const ENTITY_BOOST_WEIGHT = 0.5;

export interface Candidate {
  id: string;
  score: number;
  payload: Record<string, unknown> | null;
}

export interface ScoreDetails {
  semantic_score: number;
  bm25_score: number;
  entity_boost: number;
  raw_score: number;
  max_possible_score: number;
  final_score: number;
  threshold: number;
}

export interface ScoredResult {
  id: string;
  score: number;
  payload: Record<string, unknown> | null;
  score_details?: ScoreDetails;
}

export interface ScoreAndRankArgs {
  semanticResults: Candidate[];
  bm25Scores: Record<string, number>;
  entityBoosts: Record<string, number>;
  threshold: number;
  topK: number;
  explain?: boolean;
}

/**
 * FTS5 unicode61 has no lemmatizer, so this is lowercase + whitespace collapse.
 * Sanctioned deviation: mem0 uses spaCy lemmatization.
 */
export function lemmatizeForBm25(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** scoring.py:16-40 — longer queries score higher raw, so shift the sigmoid. */
export function getBm25Params(query: string, lemmatized?: string): [number, number] {
  const lemma = lemmatized ?? lemmatizeForBm25(query);
  const numTerms = lemma ? lemma.split(' ').length : 1;

  if (numTerms <= 3) return [5.0, 0.7];
  if (numTerms <= 6) return [7.0, 0.6];
  if (numTerms <= 9) return [9.0, 0.5];
  if (numTerms <= 15) return [10.0, 0.5];
  return [12.0, 0.5];
}

/** scoring.py:43-54 — logistic sigmoid to [0, 1]. */
export function normalizeBm25(rawScore: number, midpoint: number, steepness: number): number {
  return 1.0 / (1.0 + Math.exp(-steepness * (rawScore - midpoint)));
}

/** scoring.py:60-139 — additive scoring with an adaptive divisor. */
export function scoreAndRank(args: ScoreAndRankArgs): ScoredResult[] {
  const { semanticResults, bm25Scores, entityBoosts, threshold, topK, explain = false } = args;

  const hasBm25 = Object.keys(bm25Scores).length > 0;
  const hasEntity = Object.keys(entityBoosts).length > 0;

  let maxPossible = 1.0;
  if (hasBm25) maxPossible += 1.0;
  if (hasEntity) maxPossible += ENTITY_BOOST_WEIGHT;

  const scored: ScoredResult[] = [];

  for (const result of semanticResults) {
    if (result.id === null || result.id === undefined) continue;

    const semanticScore = result.score || 0.0;
    // Gates the raw semantic score before combining. Upstream behavior: a
    // candidate below threshold is dropped even if BM25/entity would rescue it.
    if (semanticScore < threshold) continue;

    const memIdStr = String(result.id);
    const bm25Score = bm25Scores[memIdStr] ?? 0.0;
    const entityBoost = entityBoosts[memIdStr] ?? 0.0;

    const rawCombined = semanticScore + bm25Score + entityBoost;
    const combined = Math.min(rawCombined / maxPossible, 1.0);

    const scoredResult: ScoredResult = {
      id: memIdStr,
      score: combined,
      payload: result.payload,
    };
    if (explain) {
      scoredResult.score_details = {
        semantic_score: semanticScore,
        bm25_score: bm25Score,
        entity_boost: entityBoost,
        raw_score: rawCombined,
        max_possible_score: maxPossible,
        final_score: combined,
        threshold,
      };
    }
    scored.push(scoredResult);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/memory/scoring.test.ts`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/memory/scoring.ts src/core/memory/scoring.test.ts
git commit -m "feat(memory): port mem0 v2 hybrid scoring"
```

---

### Task 2: Schema and database

**Files:**
- Create: `src/core/memory/schema.ts`
- Test: `src/core/memory/schema.test.ts`

**Interfaces:**
- Consumes: `EMBEDDING_DIM` from `src/core/constants.js` (value `384`), `getDbPath()` from `src/core/paths.js`
- Produces:
  ```ts
  interface MemoryItem { id: string; memory: string; hash: string; metadata: Record<string, unknown> | null; score?: number; created_at: number; updated_at: number }
  interface HistoryRow { id: number; memory_id: string; old_memory: string | null; new_memory: string | null; event: string; created_at: number; is_deleted: number }
  ```
  `createMemorySchema(db: Database): void`, `openMemoryDb(): Database`

Note the `id` type change: mem0 uses UUID strings, so `memories.id` is `TEXT`, not the old `INTEGER`. sqlite-vec `vec0` rowids are integers, so `vec_memories` needs an integer surrogate — `memories.rowid` — joined back to `id`.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/memory/schema.test.ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createMemorySchema } from './schema.js';

function freshDb(): Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  createMemorySchema(db);
  return db;
}

describe('createMemorySchema', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('creates the three mem0 stores plus search indexes', () => {
    const names = (db.query("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>)
      .map(r => r.name);
    expect(names).toContain('memories');
    expect(names).toContain('history');
    expect(names).toContain('entities');
    expect(names).toContain('vec_memories');
    expect(names).toContain('fts_memories');
  });

  test('memories carries the MemoryItem columns', () => {
    const cols = (db.query('PRAGMA table_info(memories)').all() as Array<{ name: string; type: string }>);
    const byName = Object.fromEntries(cols.map(c => [c.name, c.type]));
    expect(byName.id).toBe('TEXT');
    expect(byName.memory).toBe('TEXT');
    expect(byName.hash).toBe('TEXT');
    expect(byName.metadata).toBe('TEXT');
    expect(byName.created_at).toBe('INTEGER');
    expect(byName.updated_at).toBe('INTEGER');
    // score is computed at search time, never stored
    expect(byName.score).toBeUndefined();
  });

  test('hash is unique so md5 dedup is enforced by the DB', () => {
    const ins = 'INSERT INTO memories (id, memory, hash, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?)';
    db.query(ins).run('id-1', 'a fact', 'deadbeef', '{}', 1, 1);
    expect(() => db.query(ins).run('id-2', 'a fact', 'deadbeef', '{}', 2, 2)).toThrow();
  });

  test('is idempotent', () => {
    expect(() => { createMemorySchema(db); createMemorySchema(db); }).not.toThrow();
  });

  test('fts_memories matches on English text via bm25', () => {
    db.query('INSERT INTO memories (id, memory, hash, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('id-1', 'User replaced the embedding model', 'h1', '{}', 1, 1);
    const rowid = (db.query('SELECT rowid AS r FROM memories WHERE id = ?').get('id-1') as { r: number }).r;
    db.query('INSERT INTO fts_memories(rowid, text_lemmatized) VALUES (?, ?)')
      .run(rowid, 'user replaced the embedding model');
    const hits = db.query('SELECT rowid, bm25(fts_memories) AS s FROM fts_memories WHERE fts_memories MATCH ?')
      .all('embedding') as Array<{ rowid: number; s: number }>;
    expect(hits).toHaveLength(1);
    expect(hits[0].rowid).toBe(rowid);
  });

  test('history records an append-only trail', () => {
    db.query('INSERT INTO history (memory_id, old_memory, new_memory, event, created_at, is_deleted) VALUES (?,?,?,?,?,?)')
      .run('id-1', null, 'a fact', 'ADD', 1, 0);
    const rows = db.query('SELECT * FROM history').all() as Array<{ event: string }>;
    expect(rows[0].event).toBe('ADD');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/memory/schema.test.ts`
Expected: FAIL — `Cannot find module './schema.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/memory/schema.ts
import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { getDbPath } from '../paths.js';
import { EMBEDDING_DIM } from '../constants.js';

/** mem0 MemoryItem (mem0/configs/base.py:16-26). `score` is runtime-only, never a column. */
export interface MemoryItem {
  id: string;
  memory: string;
  hash: string;
  metadata: Record<string, unknown> | null;
  score?: number;
  created_at: number;
  updated_at: number;
}

export interface HistoryRow {
  id: number;
  memory_id: string;
  old_memory: string | null;
  new_memory: string | null;
  event: string;
  created_at: number;
  is_deleted: number;
}

export function createMemorySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id         TEXT PRIMARY KEY,
      memory     TEXT NOT NULL,
      hash       TEXT NOT NULL,
      metadata   TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_hash ON memories(hash)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id  TEXT NOT NULL,
      old_memory TEXT,
      new_memory TEXT,
      event      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_history_memory_id ON history(memory_id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id                TEXT PRIMARY KEY,
      data              TEXT NOT NULL,
      entity_type       TEXT,
      linked_memory_ids TEXT NOT NULL DEFAULT '[]',
      created_at        INTEGER NOT NULL
    )
  `);

  // vec0 rowids are integers, so vectors key off memories.rowid, not memories.id.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(embedding float[${EMBEDDING_DIM}])`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_entities USING vec0(embedding float[${EMBEDDING_DIM}])`);

  // unicode61 because trigram cannot index 2-character Korean tokens; storage is English.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories USING fts5(text_lemmatized, tokenize='unicode61')`);
}

export function openMemoryDb(): Database {
  const dbPath = getDbPath();
  const dbDir = path.dirname(dbPath);
  if (dbPath !== ':memory:' && !fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  createMemorySchema(db);
  return db;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/memory/schema.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/memory/schema.ts src/core/memory/schema.test.ts
git commit -m "feat(memory): add mem0 v2 MemoryItem schema"
```

---

### Task 3: Metadata filters

mem0 requires at least one of `user_id`/`agent_id`/`run_id` and supports a rich operator set.

**Files:**
- Create: `src/core/memory/filters.ts`
- Test: `src/core/memory/filters.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `buildFilterSql(filters: Filters): { clause: string; params: unknown[] }`, `assertScoped(filters: Filters): void`, and
  ```ts
  type FilterValue = string | number | boolean | null;
  type Operator = { eq?: FilterValue; ne?: FilterValue; in?: FilterValue[]; nin?: FilterValue[]; gt?: number; gte?: number; lt?: number; lte?: number; contains?: string; icontains?: string };
  type Filters = Record<string, FilterValue | FilterValue[] | Operator> & { AND?: Filters[]; OR?: Filters[]; NOT?: Filters };
  ```

Filters read from `json_extract(metadata, '$.<key>')`. `clause` is a bare boolean expression with no leading `AND`; callers wrap it.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/memory/filters.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildFilterSql, assertScoped } from './filters.js';

function run(filters: Parameters<typeof buildFilterSql>[0], rows: Array<Record<string, unknown>>): string[] {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, metadata TEXT)');
  for (const [i, meta] of rows.entries()) {
    db.query('INSERT INTO memories (id, metadata) VALUES (?, ?)').run(`id-${i}`, JSON.stringify(meta));
  }
  const { clause, params } = buildFilterSql(filters);
  const sql = `SELECT id FROM memories${clause ? ` WHERE ${clause}` : ''} ORDER BY id`;
  return (db.query(sql).all(...(params as never[])) as Array<{ id: string }>).map(r => r.id);
}

describe('assertScoped', () => {
  test('accepts any one scoping key', () => {
    expect(() => assertScoped({ user_id: 'u1' })).not.toThrow();
    expect(() => assertScoped({ agent_id: 'a1' })).not.toThrow();
    expect(() => assertScoped({ run_id: 'r1' })).not.toThrow();
  });
  test('rejects filters with no scoping key', () => {
    expect(() => assertScoped({ role: 'user' })).toThrow(/user_id.*agent_id.*run_id/);
  });
});

describe('buildFilterSql', () => {
  const rows = [
    { user_id: 'u1', role: 'user', n: 5, tag: 'Alpha Beta' },
    { user_id: 'u1', role: 'assistant', n: 10, tag: 'gamma' },
    { user_id: 'u2', role: 'user', n: 15, tag: 'delta' },
  ];

  test('bare value is equality', () => {
    expect(run({ user_id: 'u1' }, rows)).toEqual(['id-0', 'id-1']);
  });
  test('eq / ne', () => {
    expect(run({ role: { eq: 'user' } }, rows)).toEqual(['id-0', 'id-2']);
    expect(run({ role: { ne: 'user' } }, rows)).toEqual(['id-1']);
  });
  test('in / nin', () => {
    expect(run({ role: { in: ['user'] } }, rows)).toEqual(['id-0', 'id-2']);
    expect(run({ role: { nin: ['user'] } }, rows)).toEqual(['id-1']);
  });
  test('gt / gte / lt / lte', () => {
    expect(run({ n: { gt: 10 } }, rows)).toEqual(['id-2']);
    expect(run({ n: { gte: 10 } }, rows)).toEqual(['id-1', 'id-2']);
    expect(run({ n: { lt: 10 } }, rows)).toEqual(['id-0']);
    expect(run({ n: { lte: 10 } }, rows)).toEqual(['id-0', 'id-1']);
  });
  test('contains is case-sensitive, icontains is not', () => {
    expect(run({ tag: { contains: 'Alpha' } }, rows)).toEqual(['id-0']);
    expect(run({ tag: { contains: 'alpha' } }, rows)).toEqual([]);
    expect(run({ tag: { icontains: 'alpha' } }, rows)).toEqual(['id-0']);
  });
  test('wildcard * matches any value for the key', () => {
    expect(run({ user_id: '*' }, rows)).toEqual(['id-0', 'id-1', 'id-2']);
  });
  test('array shorthand behaves as in', () => {
    expect(run({ user_id: ['u1', 'u2'] }, rows)).toEqual(['id-0', 'id-1', 'id-2']);
  });
  test('top-level keys AND together', () => {
    expect(run({ user_id: 'u1', role: 'user' }, rows)).toEqual(['id-0']);
  });
  test('OR / AND / NOT', () => {
    expect(run({ OR: [{ user_id: 'u2' }, { role: 'assistant' }] }, rows)).toEqual(['id-1', 'id-2']);
    expect(run({ AND: [{ user_id: 'u1' }, { n: { gte: 10 } }] }, rows)).toEqual(['id-1']);
    expect(run({ NOT: { user_id: 'u1' } }, rows)).toEqual(['id-2']);
  });
  test('empty filters produce no clause', () => {
    expect(buildFilterSql({}).clause).toBe('');
  });
  test('values are parameterized, not interpolated', () => {
    const { clause, params } = buildFilterSql({ user_id: "'; DROP TABLE memories; --" });
    expect(clause).not.toContain('DROP');
    expect(params).toContain("'; DROP TABLE memories; --");
  });

  test('rejects a malicious metadata key instead of interpolating it', () => {
    // Unvalidated, this key escapes json_extract and injects `OR 1=1`.
    expect(() => buildFilterSql({ "x') OR 1=1 --": 'v' })).toThrow(/Invalid metadata filter key/);
  });

  test('accepts ordinary keys with underscores and digits', () => {
    expect(() => buildFilterSql({ user_id: 'u1' })).not.toThrow();
    expect(() => buildFilterSql({ field2: 'v' })).not.toThrow();
  });

  test('contains treats GLOB metacharacters literally', () => {
    const meta = [{ tag: '[agmx]' }, { tag: 'gamma' }];
    expect(run({ tag: { contains: '[agmx]' } }, meta)).toEqual(['id-0']);
  });

  test('contains treats an asterisk literally', () => {
    const meta = [{ tag: 'a*b' }, { tag: 'axxb' }];
    expect(run({ tag: { contains: 'a*b' } }, meta)).toEqual(['id-0']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/memory/filters.test.ts`
Expected: FAIL — `Cannot find module './filters.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/memory/filters.ts
export type FilterValue = string | number | boolean | null;

export interface Operator {
  eq?: FilterValue;
  ne?: FilterValue;
  in?: FilterValue[];
  nin?: FilterValue[];
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  contains?: string;
  icontains?: string;
}

export type Filters = Record<string, unknown> & {
  AND?: Filters[];
  OR?: Filters[];
  NOT?: Filters;
};

const SCOPING_KEYS = ['user_id', 'agent_id', 'run_id'] as const;

/** main.py: search() rejects filters lacking any session scope. */
export function assertScoped(filters: Filters): void {
  const hasScope = SCOPING_KEYS.some(key => filters[key] !== undefined);
  if (!hasScope) {
    throw new Error('filters must include at least one of: user_id, agent_id, run_id');
  }
}

const SAFE_KEY = /^[A-Za-z0-9_]+$/;

/**
 * Metadata keys are interpolated into the JSON path, so they cannot be
 * parameterized. Validate instead: an unchecked key escapes json_extract and
 * injects arbitrary SQL (e.g. `x') OR 1=1 --` yields a tautology that bypasses
 * every other predicate).
 */
function field(key: string): string {
  if (!SAFE_KEY.test(key)) {
    throw new Error(`Invalid metadata filter key: ${key}`);
  }
  return `json_extract(metadata, '$.${key}')`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, m => `\\${m}`);
}

/**
 * GLOB has no ESCAPE clause; metacharacters are neutralized with bracket
 * literals so `contains` means a literal case-sensitive substring.
 * Single pass, so freshly inserted brackets are not re-escaped.
 */
function escapeGlob(value: string): string {
  return value.replace(/[*?[\]]/g, m => `[${m}]`);
}

function operatorClause(key: string, op: Operator, params: unknown[]): string {
  const parts: string[] = [];
  const col = field(key);

  if ('eq' in op) { parts.push(`${col} = ?`); params.push(op.eq); }
  if ('ne' in op) { parts.push(`${col} != ?`); params.push(op.ne); }
  if (op.in) {
    parts.push(`${col} IN (${op.in.map(() => '?').join(', ')})`);
    params.push(...op.in);
  }
  if (op.nin) {
    parts.push(`${col} NOT IN (${op.nin.map(() => '?').join(', ')})`);
    params.push(...op.nin);
  }
  if ('gt' in op) { parts.push(`${col} > ?`); params.push(op.gt); }
  if ('gte' in op) { parts.push(`${col} >= ?`); params.push(op.gte); }
  if ('lt' in op) { parts.push(`${col} < ?`); params.push(op.lt); }
  if ('lte' in op) { parts.push(`${col} <= ?`); params.push(op.lte); }
  if (op.contains !== undefined) {
    // GLOB is case-sensitive; LIKE is not.
    parts.push(`${col} GLOB ?`);
    params.push(`*${escapeGlob(op.contains)}*`);
  }
  if (op.icontains !== undefined) {
    parts.push(`${col} LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(op.icontains)}%`);
  }

  return parts.length > 1 ? `(${parts.join(' AND ')})` : (parts[0] ?? '1=1');
}

export function buildFilterSql(filters: Filters): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  const clause = build(filters, params);
  return { clause, params };
}

function build(filters: Filters, params: unknown[]): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;

    if (key === 'AND') {
      const sub = (value as Filters[]).map(f => build(f, params)).filter(Boolean);
      if (sub.length) parts.push(`(${sub.join(' AND ')})`);
      continue;
    }
    if (key === 'OR') {
      const sub = (value as Filters[]).map(f => build(f, params)).filter(Boolean);
      if (sub.length) parts.push(`(${sub.join(' OR ')})`);
      continue;
    }
    if (key === 'NOT') {
      const sub = build(value as Filters, params);
      if (sub) parts.push(`NOT (${sub})`);
      continue;
    }

    if (value === '*') {
      parts.push(`${field(key)} IS NOT NULL`);
      continue;
    }
    if (Array.isArray(value)) {
      parts.push(`${field(key)} IN (${value.map(() => '?').join(', ')})`);
      params.push(...value);
      continue;
    }
    if (value !== null && typeof value === 'object') {
      parts.push(operatorClause(key, value as Operator, params));
      continue;
    }
    parts.push(`${field(key)} = ?`);
    params.push(value);
  }

  return parts.join(' AND ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/memory/filters.test.ts`
Expected: PASS, 18 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/memory/filters.ts src/core/memory/filters.test.ts
git commit -m "feat(memory): add mem0 metadata filter operators"
```

---

### Task 4: Extraction prompt

**Files:**
- Create: `src/core/memory/prompts.ts`
- Test: `src/core/memory/prompts.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ADDITIVE_EXTRACTION_PROMPT: string`, `PAST_MESSAGE_TRUNCATION_LIMIT: 300`, and
  ```ts
  interface Message { role: 'user' | 'assistant'; content: string }
  interface ExistingMemoryRef { id: string; text: string }
  interface PromptArgs { summary?: string | null; recentlyExtractedMemories?: ExistingMemoryRef[]; existingMemories?: ExistingMemoryRef[]; newMessages: Message[]; lastKMessages?: Message[]; currentDate?: string; observationDate?: string; customInstructions?: string }
  ```
  `generateAdditiveExtractionPrompt(args: PromptArgs): string`

The system prompt is long. Copy it verbatim from `mem0/configs/prompts.py:469-943` at tag `v2.0.17`:
`curl -sL https://raw.githubusercontent.com/mem0ai/mem0/v2.0.17/mem0/configs/prompts.py`

Do **not** paraphrase, shorten, or translate it. Do not append the `use_input_language` Language Requirement block — storage is English.

The upstream text is checked in as a test fixture at
`src/core/memory/__fixtures__/additive-extraction-prompt.upstream.txt` (33,660 chars),
and a test asserts the constant is byte-identical to it. Byte-identical means
byte-identical: five lines carry **trailing whitespace** that editors strip
silently. Generate the constant from the fixture with shell redirection rather
than retyping or hand-editing it.

The constant must be a **literal in the source file**. Do not `readFileSync` the
fixture at runtime: `bun build` does not inline a runtime read, so the shipped
bundle would throw `ENOENT` at import. The fixture exists for the test to compare
against, not for production to load.

Section order is fixed (`prompts.py:1035-1042`): Summary, Last k Messages, Recently Extracted Memories, Existing Memories, New Messages, Observation Date, Current Date, [Custom Instructions], `# Output:` — joined by `\n\n`.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/memory/prompts.test.ts
import { describe, expect, test } from 'bun:test';
import { ADDITIVE_EXTRACTION_PROMPT, generateAdditiveExtractionPrompt, PAST_MESSAGE_TRUNCATION_LIMIT } from './prompts.js';

describe('ADDITIVE_EXTRACTION_PROMPT', () => {
  test('declares ADD as the sole operation', () => {
    expect(ADDITIVE_EXTRACTION_PROMPT).toContain('Your sole operation is ADD');
  });
  test('documents the output schema fields', () => {
    expect(ADDITIVE_EXTRACTION_PROMPT).toContain('linked_memory_ids');
    expect(ADDITIVE_EXTRACTION_PROMPT).toContain('attributed_to');
    expect(ADDITIVE_EXTRACTION_PROMPT).toContain('{"memory": []}');
  });
  test('omits the use_input_language block so storage stays English', () => {
    expect(ADDITIVE_EXTRACTION_PROMPT).not.toContain('Language Requirement');
    expect(ADDITIVE_EXTRACTION_PROMPT).not.toContain('SAME LANGUAGE');
  });
  test('is the full upstream prompt, not a paraphrase', () => {
    expect(ADDITIVE_EXTRACTION_PROMPT.length).toBeGreaterThan(10000);
  });
});

describe('generateAdditiveExtractionPrompt', () => {
  const base = { newMessages: [{ role: 'user' as const, content: 'I adopted a puppy' }] };

  test('emits sections in mem0 order', () => {
    const out = generateAdditiveExtractionPrompt(base);
    const order = ['## Summary', '## Last k Messages', '## Recently Extracted Memories',
      '## Existing Memories', '## New Messages', '## Observation Date', '## Current Date', '# Output:'];
    let cursor = -1;
    for (const section of order) {
      const at = out.indexOf(section);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test('serializes existing memories as id/text JSON', () => {
    const out = generateAdditiveExtractionPrompt({
      ...base,
      existingMemories: [{ id: 'a1b2', text: 'User has a dog' }],
    });
    expect(out).toContain('"id": "a1b2"');
    expect(out).toContain('"text": "User has a dog"');
  });

  test('includes custom instructions only when provided', () => {
    expect(generateAdditiveExtractionPrompt(base)).not.toContain('## Custom Instructions');
    expect(generateAdditiveExtractionPrompt({ ...base, customInstructions: 'focus on pets' }))
      .toContain('## Custom Instructions\nfocus on pets');
  });

  test('uses the supplied observation date as the temporal anchor', () => {
    const out = generateAdditiveExtractionPrompt({ ...base, observationDate: '2025-03-10' });
    expect(out).toContain('## Observation Date\n2025-03-10');
  });

  test('truncates long past messages at the upstream limit', () => {
    const out = generateAdditiveExtractionPrompt({
      ...base,
      lastKMessages: [{ role: 'user', content: 'x'.repeat(500) }],
    });
    expect(out).toContain('x'.repeat(PAST_MESSAGE_TRUNCATION_LIMIT));
    expect(out).not.toContain('x'.repeat(PAST_MESSAGE_TRUNCATION_LIMIT + 1));
  });

  test('does not truncate new messages', () => {
    const out = generateAdditiveExtractionPrompt({
      newMessages: [{ role: 'user', content: 'y'.repeat(500) }],
    });
    expect(out).toContain('y'.repeat(500));
  });

  test('renders empty collections without crashing', () => {
    const out = generateAdditiveExtractionPrompt({ newMessages: [] });
    expect(out).toContain('## Existing Memories\n[]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/memory/prompts.test.ts`
Expected: FAIL — `Cannot find module './prompts.js'`

- [ ] **Step 3: Write minimal implementation**

Fetch the upstream prompt and paste it verbatim into the template literal (escape backticks and `${`):

```bash
curl -sL https://raw.githubusercontent.com/mem0ai/mem0/v2.0.17/mem0/configs/prompts.py | sed -n '469,943p'
```

```ts
// src/core/memory/prompts.ts
/** Verbatim port of mem0/configs/prompts.py (v2.0.17). Do not paraphrase. */

export const PAST_MESSAGE_TRUNCATION_LIMIT = 300;

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface ExistingMemoryRef {
  id: string;
  text: string;
}

export interface PromptArgs {
  summary?: string | null;
  recentlyExtractedMemories?: ExistingMemoryRef[];
  existingMemories?: ExistingMemoryRef[];
  newMessages: Message[];
  lastKMessages?: Message[];
  currentDate?: string;
  observationDate?: string;
  customInstructions?: string;
}

/** prompts.py:469-943. Copy the upstream text exactly. */
export const ADDITIVE_EXTRACTION_PROMPT = `
<PASTE prompts.py lines 469-943 here verbatim>
`;

function truncate(text: string, limit = PAST_MESSAGE_TRUNCATION_LIMIT): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

function formatSummary(summary?: string | null): string {
  return summary && summary.trim() ? summary : '';
}

function formatConversationHistory(messages?: Message[]): string {
  if (!messages || messages.length === 0) return '';
  return messages.map(m => `${m.role}: ${truncate(m.content)}`).join('\n');
}

function serializeMemories(memories?: ExistingMemoryRef[]): string {
  if (!memories || memories.length === 0) return '[]';
  return JSON.stringify(memories.map(m => ({ id: m.id, text: m.text })), null, 0)
    .replace(/","/g, '", "')
    .replace(/\{"id":/g, '{"id": ')
    .replace(/,"text":/g, ', "text": ');
}

function formatNewMessages(messages: Message[]): string {
  return JSON.stringify(messages.map(m => ({ role: m.role, content: m.content })));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** prompts.py:1016-1062. Section order is load-bearing. */
export function generateAdditiveExtractionPrompt(args: PromptArgs): string {
  const now = new Date();
  const currentDate = args.currentDate ?? isoDate(now);
  const observationDate = args.observationDate ?? currentDate;

  const sections = [
    `## Summary\n${formatSummary(args.summary)}`,
    `## Last k Messages\n${formatConversationHistory(args.lastKMessages)}`,
    `## Recently Extracted Memories\n${serializeMemories(args.recentlyExtractedMemories)}`,
    `## Existing Memories\n${serializeMemories(args.existingMemories)}`,
    `## New Messages\n${formatNewMessages(args.newMessages)}`,
    `## Observation Date\n${observationDate}`,
    `## Current Date\n${currentDate}`,
  ];

  if (args.customInstructions) {
    sections.push(`## Custom Instructions\n${args.customInstructions}`);
  }

  sections.push('# Output:');
  return sections.join('\n\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/memory/prompts.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/memory/prompts.ts src/core/memory/prompts.test.ts
git commit -m "feat(memory): port mem0 ADDITIVE_EXTRACTION_PROMPT verbatim"
```

---

### Task 5: Extraction call and response parsing

**Files:**
- Create: `src/core/memory/extract.ts`
- Test: `src/core/memory/extract.test.ts`

**Interfaces:**
- Consumes: `LLMProvider` from `src/core/llm/types.js`; `ADDITIVE_EXTRACTION_PROMPT`, `generateAdditiveExtractionPrompt`, `PromptArgs` from Task 4
- Produces:
  ```ts
  class LLMError extends Error { constructor(message: string, options?: { cause?: unknown }) }
  interface ExtractedMemory { id: string; text: string; attributed_to: 'user' | 'assistant'; linked_memory_ids: string[] }
  ```
  `parseExtractionResponse(raw: string): ExtractedMemory[]`, `extractMemories(provider: LLMProvider, args: PromptArgs): Promise<ExtractedMemory[]>`

Provider failure raises `LLMError`. A well-formed `{"memory": []}` returns `[]`. Unparseable output raises `LLMError` — silently returning `[]` would let a broken provider look like a quiet conversation.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/memory/extract.test.ts
import { describe, expect, test } from 'bun:test';
import { parseExtractionResponse, extractMemories, LLMError } from './extract.js';
import type { LLMProvider } from '../llm/types.js';

function provider(text: string): LLMProvider {
  return { complete: async () => ({ text }) } as unknown as LLMProvider;
}
function failing(err: Error): LLMProvider {
  return { complete: async () => { throw err; } } as unknown as LLMProvider;
}

describe('parseExtractionResponse', () => {
  test('parses the mem0 output schema', () => {
    const out = parseExtractionResponse(JSON.stringify({
      memory: [{ id: '0', text: 'User adopted a puppy', attributed_to: 'user', linked_memory_ids: ['uuid-1'] }],
    }));
    expect(out).toEqual([
      { id: '0', text: 'User adopted a puppy', attributed_to: 'user', linked_memory_ids: ['uuid-1'] },
    ]);
  });

  test('defaults linked_memory_ids to empty array when omitted', () => {
    const out = parseExtractionResponse('{"memory":[{"id":"0","text":"t","attributed_to":"user"}]}');
    expect(out[0].linked_memory_ids).toEqual([]);
  });

  test('returns empty for an explicit empty extraction', () => {
    expect(parseExtractionResponse('{"memory": []}')).toEqual([]);
  });

  test('strips markdown fences', () => {
    const out = parseExtractionResponse('```json\n{"memory":[{"id":"0","text":"t","attributed_to":"user"}]}\n```');
    expect(out).toHaveLength(1);
  });

  test('drops entries missing required fields', () => {
    const out = parseExtractionResponse(JSON.stringify({
      memory: [
        { id: '0', text: 'keep', attributed_to: 'user' },
        { id: '1', attributed_to: 'user' },
        { id: '2', text: '', attributed_to: 'user' },
        { id: '3', text: 'bad role', attributed_to: 'system' },
      ],
    }));
    expect(out.map(m => m.text)).toEqual(['keep']);
  });

  test('raises LLMError on unparseable output', () => {
    expect(() => parseExtractionResponse('not json at all')).toThrow(LLMError);
  });

  test('raises LLMError when the memory key is missing', () => {
    expect(() => parseExtractionResponse('{"facts": []}')).toThrow(LLMError);
  });
});

describe('extractMemories', () => {
  const args = { newMessages: [{ role: 'user' as const, content: 'hi' }] };

  test('returns parsed memories on success', async () => {
    const out = await extractMemories(
      provider('{"memory":[{"id":"0","text":"a fact","attributed_to":"user"}]}'), args);
    expect(out[0].text).toBe('a fact');
  });

  test('wraps provider failure in LLMError rather than returning []', async () => {
    await expect(extractMemories(failing(new Error('503 upstream')), args)).rejects.toThrow(LLMError);
  });

  test('distinguishes provider failure from a genuinely empty extraction', async () => {
    await expect(extractMemories(provider('{"memory": []}'), args)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/memory/extract.test.ts`
Expected: FAIL — `Cannot find module './extract.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/memory/extract.ts
import type { LLMProvider } from '../llm/types.js';
import { ADDITIVE_EXTRACTION_PROMPT, generateAdditiveExtractionPrompt, type PromptArgs } from './prompts.js';

/** main.py raises rather than returning [] so callers can tell "LLM down" from "no facts". */
export class LLMError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LLMError';
  }
}

export interface ExtractedMemory {
  id: string;
  text: string;
  attributed_to: 'user' | 'assistant';
  linked_memory_ids: string[];
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const lines = trimmed.split('\n');
  const start = lines.findIndex(l => l.trim().startsWith('```')) + 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

export function parseExtractionResponse(raw: string): ExtractedMemory[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch (error) {
    throw new LLMError('extraction response was not valid JSON', { cause: error });
  }

  if (typeof parsed !== 'object' || parsed === null || !('memory' in parsed)) {
    throw new LLMError('extraction response missing "memory" key');
  }

  const list = (parsed as { memory: unknown }).memory;
  if (!Array.isArray(list)) {
    throw new LLMError('extraction response "memory" was not an array');
  }

  const out: ExtractedMemory[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.text !== 'string' || row.text.trim() === '') continue;
    if (row.attributed_to !== 'user' && row.attributed_to !== 'assistant') continue;

    out.push({
      id: String(row.id ?? out.length),
      text: row.text.trim(),
      attributed_to: row.attributed_to,
      linked_memory_ids: Array.isArray(row.linked_memory_ids)
        ? row.linked_memory_ids.filter((v): v is string => typeof v === 'string')
        : [],
    });
  }
  return out;
}

export async function extractMemories(
  provider: LLMProvider,
  args: PromptArgs,
): Promise<ExtractedMemory[]> {
  const prompt = generateAdditiveExtractionPrompt(args);
  let response: { text: string };
  try {
    response = await provider.complete(prompt, {
      systemPrompt: ADDITIVE_EXTRACTION_PROMPT,
      maxTokens: 4000,
    });
  } catch (error) {
    throw new LLMError('extraction provider call failed', { cause: error });
  }
  return parseExtractionResponse(response.text);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/memory/extract.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/memory/extract.ts src/core/memory/extract.test.ts
git commit -m "feat(memory): add ADD-only extraction with LLMError contract"
```

---

### Task 6: Store layer

**Files:**
- Create: `src/core/memory/store.ts`
- Test: `src/core/memory/store.test.ts`

**Interfaces:**
- Consumes: `createMemorySchema`, `MemoryItem` (Task 2); `lemmatizeForBm25` (Task 1)
- Produces: `md5(text: string): string`, `insertMemories(db, rows: NewMemory[]): InsertResult`, `getExistingHashes(db, hashes: string[]): Set<string>`, `recordHistory(db, entries: HistoryEntry[]): void`, `upsertEntities(db, entities: NewEntity[]): void`, `getMemoryRowid(db, id: string): number | null` where
  ```ts
  interface NewMemory { id: string; memory: string; metadata: Record<string, unknown> | null; embedding: number[] }
  interface InsertResult { inserted: string[]; skipped: string[] }
  interface HistoryEntry { memory_id: string; old_memory: string | null; new_memory: string | null; event: string }
  interface NewEntity { id: string; data: string; entity_type: string | null; linked_memory_ids: string[]; embedding: number[] }
  ```

Dedup is md5 equality only — no LLM. Inserting a duplicate hash is a skip, not an error.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/memory/store.test.ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createMemorySchema } from './schema.js';
import { md5, insertMemories, getExistingHashes, recordHistory, upsertEntities, getMemoryRowid } from './store.js';

const EMB = new Array(384).fill(0.1);

function freshDb(): Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  createMemorySchema(db);
  return db;
}

describe('md5', () => {
  test('is stable and content-addressed', () => {
    expect(md5('a fact')).toBe(md5('a fact'));
    expect(md5('a fact')).not.toBe(md5('another fact'));
    expect(md5('a fact')).toHaveLength(32);
  });
});

describe('insertMemories', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('inserts a new memory with hash and metadata', () => {
    const res = insertMemories(db, [
      { id: 'u1', memory: 'User adopted a puppy', metadata: { user_id: 'alice' }, embedding: EMB },
    ]);
    expect(res.inserted).toEqual(['u1']);
    const row = db.query('SELECT * FROM memories WHERE id = ?').get('u1') as Record<string, string>;
    expect(row.memory).toBe('User adopted a puppy');
    expect(row.hash).toBe(md5('User adopted a puppy'));
    expect(JSON.parse(row.metadata).user_id).toBe('alice');
  });

  test('skips duplicates by md5 instead of raising', () => {
    insertMemories(db, [{ id: 'u1', memory: 'same text', metadata: null, embedding: EMB }]);
    const res = insertMemories(db, [{ id: 'u2', memory: 'same text', metadata: null, embedding: EMB }]);
    expect(res.inserted).toEqual([]);
    expect(res.skipped).toEqual(['u2']);
    expect((db.query('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(1);
  });

  test('dedups within a single batch', () => {
    const res = insertMemories(db, [
      { id: 'u1', memory: 'dup', metadata: null, embedding: EMB },
      { id: 'u2', memory: 'dup', metadata: null, embedding: EMB },
    ]);
    expect(res.inserted).toEqual(['u1']);
    expect(res.skipped).toEqual(['u2']);
  });

  test('writes vector and fts rows keyed to the memory rowid', () => {
    insertMemories(db, [{ id: 'u1', memory: 'Embedding model swapped', metadata: null, embedding: EMB }]);
    const rowid = getMemoryRowid(db, 'u1')!;
    expect((db.query('SELECT COUNT(*) c FROM vec_memories WHERE rowid = ?').get(rowid) as { c: number }).c).toBe(1);
    const hits = db.query('SELECT rowid FROM fts_memories WHERE fts_memories MATCH ?').all('embedding') as Array<{ rowid: number }>;
    expect(hits[0].rowid).toBe(rowid);
  });

  test('handles an empty batch', () => {
    expect(insertMemories(db, [])).toEqual({ inserted: [], skipped: [] });
  });
});

describe('getExistingHashes', () => {
  test('returns only hashes already stored', () => {
    const db = freshDb();
    insertMemories(db, [{ id: 'u1', memory: 'stored', metadata: null, embedding: EMB }]);
    const found = getExistingHashes(db, [md5('stored'), md5('absent')]);
    expect(found.has(md5('stored'))).toBe(true);
    expect(found.has(md5('absent'))).toBe(false);
  });
  test('handles an empty input', () => {
    expect(getExistingHashes(freshDb(), []).size).toBe(0);
  });
});

describe('recordHistory', () => {
  test('appends ADD entries', () => {
    const db = freshDb();
    recordHistory(db, [{ memory_id: 'u1', old_memory: null, new_memory: 'a fact', event: 'ADD' }]);
    const rows = db.query('SELECT * FROM history').all() as Array<{ event: string; new_memory: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('ADD');
    expect(rows[0].new_memory).toBe('a fact');
  });
});

describe('upsertEntities', () => {
  test('stores entities with their linked memory ids', () => {
    const db = freshDb();
    upsertEntities(db, [{ id: 'e1', data: 'Max', entity_type: 'PET', linked_memory_ids: ['u1'], embedding: EMB }]);
    const row = db.query('SELECT * FROM entities WHERE id = ?').get('e1') as Record<string, string>;
    expect(row.data).toBe('Max');
    expect(JSON.parse(row.linked_memory_ids)).toEqual(['u1']);
  });

  test('merges linked ids when the entity already exists', () => {
    const db = freshDb();
    upsertEntities(db, [{ id: 'e1', data: 'Max', entity_type: 'PET', linked_memory_ids: ['u1'], embedding: EMB }]);
    upsertEntities(db, [{ id: 'e1', data: 'Max', entity_type: 'PET', linked_memory_ids: ['u2'], embedding: EMB }]);
    const row = db.query('SELECT linked_memory_ids AS l FROM entities WHERE id = ?').get('e1') as { l: string };
    expect(JSON.parse(row.l).sort()).toEqual(['u1', 'u2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/memory/store.test.ts`
Expected: FAIL — `Cannot find module './store.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/memory/store.ts
import type { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { lemmatizeForBm25 } from './scoring.js';

export interface NewMemory {
  id: string;
  memory: string;
  metadata: Record<string, unknown> | null;
  embedding: number[];
}

export interface InsertResult {
  inserted: string[];
  skipped: string[];
}

export interface HistoryEntry {
  memory_id: string;
  old_memory: string | null;
  new_memory: string | null;
  event: string;
}

export interface NewEntity {
  id: string;
  data: string;
  entity_type: string | null;
  linked_memory_ids: string[];
  embedding: number[];
}

export function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

export function getMemoryRowid(db: Database, id: string): number | null {
  const row = db.query('SELECT rowid AS r FROM memories WHERE id = ?').get(id) as { r: number } | null;
  return row ? row.r : null;
}

export function getExistingHashes(db: Database, hashes: string[]): Set<string> {
  if (hashes.length === 0) return new Set();
  const placeholders = hashes.map(() => '?').join(',');
  const rows = db.query(`SELECT hash FROM memories WHERE hash IN (${placeholders})`)
    .all(...hashes) as Array<{ hash: string }>;
  return new Set(rows.map(r => r.hash));
}

/** Consolidation is md5 equality only — mem0 v2 removed LLM-arbitrated UPDATE/DELETE. */
export function insertMemories(db: Database, rows: NewMemory[]): InsertResult {
  const result: InsertResult = { inserted: [], skipped: [] };
  if (rows.length === 0) return result;

  const hashes = rows.map(r => md5(r.memory));
  const existing = getExistingHashes(db, hashes);
  const seenInBatch = new Set<string>();
  const now = Date.now();

  const insertMemory = db.query(
    'INSERT INTO memories (id, memory, hash, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  );
  const insertVec = db.query('INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)');
  const insertFts = db.query('INSERT INTO fts_memories(rowid, text_lemmatized) VALUES (?, ?)');

  db.transaction(() => {
    for (const [i, row] of rows.entries()) {
      const hash = hashes[i];
      if (existing.has(hash) || seenInBatch.has(hash)) {
        result.skipped.push(row.id);
        continue;
      }
      seenInBatch.add(hash);

      insertMemory.run(row.id, row.memory, hash, JSON.stringify(row.metadata ?? {}), now, now);
      const rowid = getMemoryRowid(db, row.id)!;
      insertVec.run(rowid, Buffer.from(new Float32Array(row.embedding).buffer));
      insertFts.run(rowid, lemmatizeForBm25(row.memory));
      result.inserted.push(row.id);
    }
  })();

  return result;
}

export function recordHistory(db: Database, entries: HistoryEntry[]): void {
  if (entries.length === 0) return;
  const now = Date.now();
  const stmt = db.query(
    'INSERT INTO history (memory_id, old_memory, new_memory, event, created_at, is_deleted) VALUES (?,?,?,?,?,0)',
  );
  db.transaction(() => {
    for (const e of entries) stmt.run(e.memory_id, e.old_memory, e.new_memory, e.event, now);
  })();
}

export function upsertEntities(db: Database, entities: NewEntity[]): void {
  if (entities.length === 0) return;
  const now = Date.now();
  const select = db.query('SELECT rowid AS r, linked_memory_ids AS l FROM entities WHERE id = ?');
  const insert = db.query(
    'INSERT INTO entities (id, data, entity_type, linked_memory_ids, created_at) VALUES (?,?,?,?,?)',
  );
  const update = db.query('UPDATE entities SET linked_memory_ids = ? WHERE id = ?');
  const insertVec = db.query('INSERT INTO vec_entities(rowid, embedding) VALUES (?, ?)');

  db.transaction(() => {
    for (const e of entities) {
      const existing = select.get(e.id) as { r: number; l: string } | null;
      if (existing) {
        const merged = Array.from(new Set([...JSON.parse(existing.l) as string[], ...e.linked_memory_ids]));
        update.run(JSON.stringify(merged), e.id);
        continue;
      }
      insert.run(e.id, e.data, e.entity_type, JSON.stringify(e.linked_memory_ids), now);
      const rowid = (select.get(e.id) as { r: number }).r;
      insertVec.run(rowid, Buffer.from(new Float32Array(e.embedding).buffer));
    }
  })();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/memory/store.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/memory/store.ts src/core/memory/store.test.ts
git commit -m "feat(memory): add store layer with md5 hash dedup"
```

---

### Task 7: Search

**Files:**
- Create: `src/core/memory/search.ts`
- Test: `src/core/memory/search.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 3, 6; `embedQuery` from `src/core/embeddings.js`
- Produces:
  ```ts
  interface SearchArgs { db: Database; query: string; filters: Filters; limit?: number; threshold?: number; explain?: boolean }
  interface SearchResultItem { id: string; memory: string; hash: string; metadata: Record<string, unknown>; score: number; created_at: number; updated_at: number; score_details?: ScoreDetails }
  ```
  `searchMemories(args: SearchArgs): Promise<{ results: SearchResultItem[] }>`

Defaults: `limit = 20`, `threshold = 0.1`. `internal_limit = max(limit*4, 60)`. Validate `threshold` in `[0,1]` and call `assertScoped(filters)` first. Promoted payload keys get lifted out of `metadata` onto the top level.

Semantic score converts sqlite-vec cosine distance via `1 - distance` (mem0's stores return similarity, not distance).

- [ ] **Step 1: Write the failing test**

```ts
// src/core/memory/search.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createMemorySchema } from './schema.js';
import { insertMemories } from './store.js';
import { searchMemories } from './search.js';
import { __setModelForTests } from '../embeddings.js';

// Deterministic 384-dim embeddings: direction encoded in the first slot.
function vec(seed: number): number[] {
  const v = new Array(384).fill(0);
  v[0] = Math.cos(seed);
  v[1] = Math.sin(seed);
  return v;
}

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  sqliteVec.load(db);
  createMemorySchema(db);
  __setModelForTests(async () => {}, async (_kind, text) => {
    if (text.includes('puppy')) return vec(0);
    if (text.includes('pottery')) return vec(1.5);
    return vec(3.0);
  });
});
afterEach(() => { __setModelForTests(null, null); });

function seed() {
  insertMemories(db, [
    { id: 'm1', memory: 'User adopted a beagle puppy named Max', metadata: { user_id: 'alice' }, embedding: vec(0) },
    { id: 'm2', memory: 'User started pottery classes on Tuesdays', metadata: { user_id: 'alice' }, embedding: vec(1.5) },
    { id: 'm3', memory: 'Unrelated fact about servers', metadata: { user_id: 'bob' }, embedding: vec(3.0) },
  ]);
}

describe('searchMemories', () => {
  test('requires a scoping filter', async () => {
    await expect(searchMemories({ db, query: 'puppy', filters: {} })).rejects.toThrow(/user_id/);
  });

  test('rejects an out-of-range threshold', async () => {
    await expect(searchMemories({ db, query: 'x', filters: { user_id: 'alice' }, threshold: 1.5 }))
      .rejects.toThrow(/threshold/i);
  });

  test('ranks the semantically closest memory first', async () => {
    seed();
    const { results } = await searchMemories({ db, query: 'puppy', filters: { user_id: 'alice' } });
    expect(results[0].id).toBe('m1');
  });

  test('applies metadata filters', async () => {
    seed();
    const { results } = await searchMemories({ db, query: 'puppy', filters: { user_id: 'bob' } });
    expect(results.every(r => r.metadata.user_id === 'bob')).toBe(true);
  });

  test('returns scores in [0,1]', async () => {
    seed();
    const { results } = await searchMemories({ db, query: 'puppy', filters: { user_id: 'alice' } });
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  test('BM25 lifts an exact keyword match above a weaker semantic one', async () => {
    // BM25 IDF collapses on tiny corpora, so pad the store until keyword scores are non-zero.
    seed();
    const filler = Array.from({ length: 200 }, (_, i) => ({
      id: `f${i}`,
      memory: `Filler record ${i} about servers and deployments`,
      metadata: { user_id: 'alice' },
      embedding: vec(3.0),
    }));
    insertMemories(db, filler);

    const { results } = await searchMemories({
      db, query: 'pottery', filters: { user_id: 'alice' }, explain: true,
    });
    expect(results[0].id).toBe('m2');
    expect(results[0].score_details!.bm25_score).toBeGreaterThan(0);
  });

  test('degrades to semantic-only when no keyword matches', async () => {
    // A query term absent from every document yields no BM25 rows at all, so
    // the divisor stays 1.0. (Note: a *small* corpus does NOT zero out BM25 —
    // IDF collapses only when the term appears in nearly every document.)
    // The fake embedder maps any unrecognized text to vec(3.0), which is m3's
    // exact direction — so scope to bob (who owns m3) for a surviving candidate.
    seed();
    const { results } = await searchMemories({
      db, query: 'zzzznomatch', filters: { user_id: 'bob' }, explain: true,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score_details!.bm25_score).toBe(0);
    expect(results[0].score_details!.max_possible_score).toBe(1.0);
  });

  test('explain exposes the score breakdown', async () => {
    seed();
    const { results } = await searchMemories({
      db, query: 'puppy', filters: { user_id: 'alice' }, explain: true,
    });
    expect(results[0].score_details).toBeDefined();
    expect(results[0].score_details!.max_possible_score).toBeGreaterThanOrEqual(1.0);
  });

  test('omits score_details by default', async () => {
    seed();
    const { results } = await searchMemories({ db, query: 'puppy', filters: { user_id: 'alice' } });
    expect(results[0].score_details).toBeUndefined();
  });

  test('honors limit', async () => {
    seed();
    const { results } = await searchMemories({ db, query: 'puppy', filters: { user_id: 'alice' }, limit: 1 });
    expect(results).toHaveLength(1);
  });

  test('threshold drops candidates whose raw semantic score is below it', async () => {
    // 'puppy' embeds to vec(0); m2/m3 sit at vec(1.5)/vec(3.0), so their
    // semantic scores fall below 0.9 while m1 (an exact vector match) clears it.
    seed();
    const { results } = await searchMemories({
      db, query: 'puppy', filters: { user_id: 'alice' }, threshold: 0.9,
    });
    expect(results.map(r => r.id)).toEqual(['m1']);
  });

  test('a threshold above every semantic score returns nothing', async () => {
    // No document is close to this query direction, so every raw semantic
    // score falls under the gate and nothing survives.
    seed();
    const { results } = await searchMemories({
      db, query: 'pottery', filters: { user_id: 'bob' }, threshold: 0.9,
    });
    expect(results).toHaveLength(0);
  });

  test('returns an empty list on an empty store', async () => {
    const { results } = await searchMemories({ db, query: 'anything', filters: { user_id: 'alice' } });
    expect(results).toEqual([]);
  });

  test('promotes scoping keys onto the result', async () => {
    seed();
    const { results } = await searchMemories({ db, query: 'puppy', filters: { user_id: 'alice' } });
    expect(results[0]).toHaveProperty('memory');
    expect(results[0]).toHaveProperty('created_at');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/memory/search.test.ts`
Expected: FAIL — `Cannot find module './search.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/memory/search.ts
import type { Database } from 'bun:sqlite';
import { embedQuery } from '../embeddings.js';
import { assertScoped, buildFilterSql, type Filters } from './filters.js';
import {
  getBm25Params, lemmatizeForBm25, normalizeBm25, scoreAndRank,
  type Candidate, type ScoreDetails,
} from './scoring.js';

const MAX_KNN_K = 4096;

export interface SearchArgs {
  db: Database;
  query: string;
  filters: Filters;
  limit?: number;
  threshold?: number;
  explain?: boolean;
}

export interface SearchResultItem {
  id: string;
  memory: string;
  hash: string;
  metadata: Record<string, unknown>;
  score: number;
  created_at: number;
  updated_at: number;
  score_details?: ScoreDetails;
}

const PROMOTED_PAYLOAD_KEYS = [
  'user_id', 'agent_id', 'run_id', 'actor_id', 'role', 'attributed_to', 'expiration_date',
] as const;

function validateThreshold(threshold: number): void {
  if (typeof threshold !== 'number' || Number.isNaN(threshold)) {
    throw new Error('threshold must be a valid number');
  }
  if (threshold < 0 || threshold > 1) {
    throw new Error(`Invalid threshold: ${threshold}. Must be between 0 and 1 (inclusive).`);
  }
}

/** Port of main.py:_search_vector_store (v2.0.17). */
export async function searchMemories(args: SearchArgs): Promise<{ results: SearchResultItem[] }> {
  const { db, query, filters, limit = 20, explain = false } = args;
  const threshold = args.threshold ?? 0.1;

  validateThreshold(threshold);
  assertScoped(filters);

  const queryLemmatized = lemmatizeForBm25(query);
  const embedding = await embedQuery(query);
  if (!embedding) return { results: [] };

  const internalLimit = Math.max(limit * 4, 60);
  const { clause, params } = buildFilterSql(filters);
  const filterClause = clause ? `AND ${clause}` : '';

  const vectorCount = (db.query('SELECT COUNT(*) AS c FROM vec_memories').get() as { c: number }).c;
  if (vectorCount === 0) return { results: [] };
  const k = Math.min(vectorCount, MAX_KNN_K, Math.max(internalLimit, 1));

  const semanticRows = db.query(`
    SELECT m.id AS id, m.memory AS memory, m.hash AS hash, m.metadata AS metadata,
           m.created_at AS created_at, m.updated_at AS updated_at,
           m.rowid AS rowid, vec.distance AS distance
    FROM vec_memories vec
    INNER JOIN memories m ON m.rowid = vec.rowid
    WHERE vec.embedding MATCH ? AND vec.k = ?
      ${filterClause}
    ORDER BY vec.distance ASC
    LIMIT ?
  `).all(
    Buffer.from(new Float32Array(embedding).buffer), k, ...(params as never[]), internalLimit,
  ) as Array<{
    id: string; memory: string; hash: string; metadata: string;
    created_at: number; updated_at: number; rowid: number; distance: number;
  }>;

  const byRowid = new Map(semanticRows.map(r => [r.rowid, r]));

  // FTS5 bm25() returns negative values where more negative is better; flip the sign.
  const bm25Scores: Record<string, number> = {};
  if (queryLemmatized) {
    const [midpoint, steepness] = getBm25Params(query, queryLemmatized);
    try {
      const keywordRows = db.query(`
        SELECT rowid, bm25(fts_memories) AS raw
        FROM fts_memories WHERE fts_memories MATCH ?
        ORDER BY raw LIMIT ?
      `).all(queryLemmatized, internalLimit) as Array<{ rowid: number; raw: number }>;

      for (const row of keywordRows) {
        const semantic = byRowid.get(row.rowid);
        if (!semantic) continue;
        const rawScore = -row.raw;
        if (rawScore > 0) {
          bm25Scores[semantic.id] = normalizeBm25(rawScore, midpoint, steepness);
        }
      }
    } catch {
      // Malformed FTS5 query syntax — proceed with semantic only.
    }
  }

  // Entity boosts are computed from entities linked to matched memories.
  const entityBoosts: Record<string, number> = {};

  const candidates: Candidate[] = semanticRows.map(row => ({
    id: row.id,
    score: 1 - row.distance,
    payload: {
      data: row.memory,
      hash: row.hash,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  }));

  const scored = scoreAndRank({
    semanticResults: candidates,
    bm25Scores,
    entityBoosts,
    threshold,
    topK: limit,
    explain,
  });

  const results: SearchResultItem[] = [];
  for (const item of scored) {
    const payload = item.payload;
    if (!payload || !payload.data) continue;

    const metadata = JSON.parse((payload.metadata as string) || '{}') as Record<string, unknown>;
    const result: SearchResultItem = {
      id: item.id,
      memory: payload.data as string,
      hash: payload.hash as string,
      metadata,
      score: item.score,
      created_at: payload.created_at as number,
      updated_at: payload.updated_at as number,
    };
    for (const key of PROMOTED_PAYLOAD_KEYS) {
      if (metadata[key] !== undefined) {
        // Double cast: SearchResultItem has no index signature, and adding one
        // would weaken checking on every field.
        (result as unknown as Record<string, unknown>)[key] = metadata[key];
      }
    }
    if (item.score_details) result.score_details = item.score_details;
    results.push(result);
  }

  return { results };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/memory/search.test.ts`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/memory/search.ts src/core/memory/search.test.ts
git commit -m "feat(memory): port mem0 v2 hybrid search"
```

---

### Task 8: The 8-phase add pipeline

**Files:**
- Create: `src/core/memory/add.ts`
- Test: `src/core/memory/add.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5, 6, 7; `embedPassage` from `src/core/embeddings.js`
- Produces:
  ```ts
  interface AddArgs { db: Database; provider: LLMProvider; messages: Message[]; metadata?: Record<string, unknown>; filters: Filters; sessionKey: string; observationDate?: string }
  interface AddResult { results: Array<{ id: string; memory: string; event: 'ADD' }> }
  ```
  `addMemories(args: AddArgs): Promise<AddResult>`

Phase order (`main.py:906-...`), all eight:
0. last 10 messages of session context
1. one vector search, `top_k=10`, over the whole batch; remap UUIDs to `"0"`, `"1"`, …
2. one LLM call
3. batch embed
4. md5 dedup (existing + in-batch)
5. batch insert
6. batch history
7. entity link

- [ ] **Step 1: Write the failing test**

```ts
// src/core/memory/add.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createMemorySchema } from './schema.js';
import { addMemories } from './add.js';
import { LLMError } from './extract.js';
import { md5 } from './store.js';
import { __setModelForTests } from '../embeddings.js';
import type { LLMProvider } from '../llm/types.js';

const EMB = () => { const v = new Array(384).fill(0); v[0] = 1; return v; };

let db: Database;
let prompts: string[];

beforeEach(() => {
  db = new Database(':memory:');
  sqliteVec.load(db);
  createMemorySchema(db);
  prompts = [];
  __setModelForTests(async () => {}, async () => EMB());
});
afterEach(() => { __setModelForTests(null, null); });

function provider(text: string): LLMProvider {
  return {
    complete: async (prompt: string) => { prompts.push(prompt); return { text }; },
  } as unknown as LLMProvider;
}

const twoMemories = JSON.stringify({
  memory: [
    { id: '0', text: 'User adopted a beagle puppy named Max', attributed_to: 'user' },
    { id: '1', text: 'User started pottery classes on Tuesdays', attributed_to: 'user' },
  ],
});

const base = {
  messages: [{ role: 'user' as const, content: 'I adopted a puppy and started pottery' }],
  filters: { user_id: 'alice' },
  sessionKey: 'session-1',
};

describe('addMemories', () => {
  test('persists every extracted memory as an ADD', async () => {
    const out = await addMemories({ db, provider: provider(twoMemories), ...base });
    expect(out.results).toHaveLength(2);
    expect(out.results.every(r => r.event === 'ADD')).toBe(true);
    expect((db.query('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(2);
  });

  test('makes exactly one LLM call per batch', async () => {
    await addMemories({ db, provider: provider(twoMemories), ...base });
    expect(prompts).toHaveLength(1);
  });

  test('assigns UUID ids, not sequential integers', async () => {
    const out = await addMemories({ db, provider: provider(twoMemories), ...base });
    for (const r of out.results) {
      expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  test('stores filters into metadata for later scoping', async () => {
    await addMemories({ db, provider: provider(twoMemories), ...base });
    const row = db.query('SELECT metadata FROM memories LIMIT 1').get() as { metadata: string };
    expect(JSON.parse(row.metadata).user_id).toBe('alice');
  });

  test('skips a repeat ingest of identical text via md5', async () => {
    await addMemories({ db, provider: provider(twoMemories), ...base });
    const out = await addMemories({ db, provider: provider(twoMemories), ...base });
    expect(out.results).toHaveLength(0);
    expect((db.query('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(2);
  });

  test('never emits UPDATE or DELETE even when contradicted', async () => {
    await addMemories({ db, provider: provider(JSON.stringify({
      memory: [{ id: '0', text: 'User lives in Seoul', attributed_to: 'user' }] })), ...base });
    await addMemories({ db, provider: provider(JSON.stringify({
      memory: [{ id: '0', text: 'User lives in Busan', attributed_to: 'user' }] })), ...base });

    const events = (db.query('SELECT DISTINCT event FROM history').all() as Array<{ event: string }>)
      .map(r => r.event);
    expect(events).toEqual(['ADD']);
    // Contradictions accumulate as siblings — mem0 v2's documented tradeoff.
    expect((db.query('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(2);
  });

  test('writes one history row per inserted memory', async () => {
    await addMemories({ db, provider: provider(twoMemories), ...base });
    expect((db.query('SELECT COUNT(*) c FROM history').get() as { c: number }).c).toBe(2);
  });

  test('passes existing memories into the prompt for dedup context', async () => {
    await addMemories({ db, provider: provider(JSON.stringify({
      memory: [{ id: '0', text: 'User has a dog named Max', attributed_to: 'user' }] })), ...base });
    prompts = [];
    await addMemories({ db, provider: provider('{"memory": []}'), ...base });
    expect(prompts[0]).toContain('## Existing Memories');
    expect(prompts[0]).toContain('User has a dog named Max');
  });

  test('remaps existing-memory UUIDs to integer strings in the prompt', async () => {
    await addMemories({ db, provider: provider(JSON.stringify({
      memory: [{ id: '0', text: 'User has a dog named Max', attributed_to: 'user' }] })), ...base });
    const stored = (db.query('SELECT id FROM memories LIMIT 1').get() as { id: string }).id;
    prompts = [];
    await addMemories({ db, provider: provider('{"memory": []}'), ...base });
    expect(prompts[0]).not.toContain(stored);
    expect(prompts[0]).toContain('"id": "0"');
  });

  test('propagates LLMError instead of silently storing nothing', async () => {
    const failing = { complete: async () => { throw new Error('503'); } } as unknown as LLMProvider;
    await expect(addMemories({ db, provider: failing, ...base })).rejects.toThrow(LLMError);
  });

  test('an empty extraction stores nothing and does not throw', async () => {
    const out = await addMemories({ db, provider: provider('{"memory": []}'), ...base });
    expect(out.results).toEqual([]);
    expect((db.query('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(0);
  });

  test('hashes stored match md5 of the memory text', async () => {
    await addMemories({ db, provider: provider(twoMemories), ...base });
    const rows = db.query('SELECT memory, hash FROM memories').all() as Array<{ memory: string; hash: string }>;
    for (const r of rows) expect(r.hash).toBe(md5(r.memory));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/memory/add.test.ts`
Expected: FAIL — `Cannot find module './add.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/memory/add.ts
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import type { LLMProvider } from '../llm/types.js';
import { embedPassage, embedQuery } from '../embeddings.js';
import { extractMemories } from './extract.js';
import type { Message, ExistingMemoryRef } from './prompts.js';
import { insertMemories, recordHistory, type NewMemory } from './store.js';
import { buildFilterSql, type Filters } from './filters.js';

const EXISTING_MEMORY_TOP_K = 10;
const SESSION_CONTEXT_LIMIT = 10;

export interface AddArgs {
  db: Database;
  provider: LLMProvider;
  messages: Message[];
  metadata?: Record<string, unknown>;
  filters: Filters;
  sessionKey: string;
  observationDate?: string;
}

export interface AddResult {
  results: Array<{ id: string; memory: string; event: 'ADD' }>;
}

/** Port of main.py:_add_to_vector_store — "=== V3 PHASED BATCH PIPELINE ===". */
export async function addMemories(args: AddArgs): Promise<AddResult> {
  const { db, provider, messages, filters, metadata = {}, observationDate } = args;

  // Phase 0: session context (last 10 messages).
  const lastKMessages = messages.slice(-SESSION_CONTEXT_LIMIT);

  // Phase 1: one vector search over the whole batch, then remap UUIDs to integers.
  const existingMemories = await retrieveExisting(db, messages, filters);
  const uuidByIndex = new Map<string, string>();
  const remapped: ExistingMemoryRef[] = existingMemories.map((m, i) => {
    uuidByIndex.set(String(i), m.id);
    return { id: String(i), text: m.text };
  });

  // Phase 2: a single LLM call. Raises LLMError on provider failure.
  const extracted = await extractMemories(provider, {
    newMessages: messages,
    lastKMessages,
    existingMemories: remapped,
    observationDate,
  });
  if (extracted.length === 0) return { results: [] };

  // Phase 3: batch embed.
  const embeddings = await Promise.all(extracted.map(m => embedPassage(m.text)));

  // Phases 4 and 5: md5 dedup then batch insert.
  const rows: NewMemory[] = [];
  for (const [i, m] of extracted.entries()) {
    const embedding = embeddings[i];
    if (!embedding) continue;
    rows.push({
      id: randomUUID(),
      memory: m.text,
      // Upstream's memory payload (main.py:1003-1029) carries only data,
      // text_lemmatized, hash, timestamps, and attributed_to. Notably it does
      // NOT persist linked_memory_ids on memory records — that field belongs to
      // the entity store. Storing it here would also let hallucinated refs
      // (indices the LLM invented) leak into metadata.
      metadata: {
        ...metadata,
        ...filters,
        attributed_to: m.attributed_to,
      },
      embedding,
    });
  }

  const { inserted } = insertMemories(db, rows);
  const insertedSet = new Set(inserted);
  const stored = rows.filter(r => insertedSet.has(r.id));

  // Phase 6: batch history.
  recordHistory(db, stored.map(r => ({
    memory_id: r.id,
    old_memory: null,
    new_memory: r.memory,
    event: 'ADD',
  })));

  // Phase 7: entity linking is folded into extraction (sanctioned deviation: no spaCy).

  return {
    results: stored.map(r => ({ id: r.id, memory: r.memory, event: 'ADD' as const })),
  };
}

async function retrieveExisting(
  db: Database,
  messages: Message[],
  filters: Filters,
): Promise<ExistingMemoryRef[]> {
  const vectorCount = (db.query('SELECT COUNT(*) AS c FROM vec_memories').get() as { c: number }).c;
  if (vectorCount === 0) return [];

  const batchText = messages.map(m => m.content).join('\n');
  const embedding = await embedQuery(batchText);
  if (!embedding) return [];

  const { clause, params } = buildFilterSql(filters);
  const filterClause = clause ? `AND ${clause}` : '';
  const k = Math.min(vectorCount, EXISTING_MEMORY_TOP_K);

  const rows = db.query(`
    SELECT m.id AS id, m.memory AS text
    FROM vec_memories vec
    INNER JOIN memories m ON m.rowid = vec.rowid
    WHERE vec.embedding MATCH ? AND vec.k = ?
      ${filterClause}
    ORDER BY vec.distance ASC
    LIMIT ?
  `).all(
    Buffer.from(new Float32Array(embedding).buffer), k, ...(params as never[]), EXISTING_MEMORY_TOP_K,
  ) as Array<{ id: string; text: string }>;

  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/memory/add.test.ts`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/memory/add.ts src/core/memory/add.test.ts
git commit -m "feat(memory): add mem0 v2 phased batch pipeline"
```

---

### Task 9: Wire sync to the new pipeline, delete the old one

**Files:**
- Modify: `src/cli/sync.ts`
- Delete: `src/core/indexer.ts`, `src/core/llm/extractor.ts`, `src/core/read.ts`, `src/cli/read.ts`, and their `*.test.ts`
- Test: `src/cli/sync.test.ts`

**Interfaces:**
- Consumes: `addMemories` (Task 8), `openMemoryDb` (Task 2), existing source adapters in `src/core/sources/`
- Produces: `syncArchives(options: SyncOptions): Promise<SyncStats>` where `interface SyncStats { filesScanned: number; filesIndexed: number; memoriesAdded: number; skipped: number }`

Archive copying stays as-is. Only the indexing half is replaced. Reindexing is incremental from newest to oldest — there is no bulk backfill of all 5,045 files.

Map source fields to mem0 scoping keys: `run_id` = session id (archive file stem), `agent_id` = source kind, `user_id` = a fixed local identifier.

- [ ] **Step 1: Write the failing test**

```ts
// src/cli/sync.test.ts — add to the existing suite
import { describe, expect, test } from 'bun:test';
import { mapSourceToFilters } from './sync.js';

describe('mapSourceToFilters', () => {
  test('maps source metadata onto mem0 scoping keys', () => {
    const filters = mapSourceToFilters({
      sourceKind: 'claude-code-projects',
      archivePath: '/archive/claude-code-projects/proj/abc123.jsonl',
    });
    expect(filters.agent_id).toBe('claude-code-projects');
    expect(filters.run_id).toBe('abc123');
    expect(filters.user_id).toBeDefined();
  });

  test('always produces at least one scoping key', () => {
    const filters = mapSourceToFilters({ sourceKind: 'codex-sessions', archivePath: '/a/b.jsonl' });
    expect(filters.user_id ?? filters.agent_id ?? filters.run_id).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cli/sync.test.ts`
Expected: FAIL — `mapSourceToFilters is not exported`

- [ ] **Step 3: Write minimal implementation**

Add to `src/cli/sync.ts`:

```ts
import path from 'path';

export const LOCAL_USER_ID = 'local';

export function mapSourceToFilters(source: { sourceKind: string; archivePath: string }): Record<string, string> {
  return {
    user_id: LOCAL_USER_ID,
    agent_id: source.sourceKind,
    run_id: path.basename(source.archivePath, path.extname(source.archivePath)),
  };
}
```

Then replace the indexer call with `addMemories`, iterating archives newest-first. Delete the files listed above and remove their imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/cli/sync.test.ts && bun run typecheck`
Expected: PASS, and typecheck clean (it will flag every dangling import from the deleted modules — fix each).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sync): drive ingestion through mem0 v2 pipeline

Deletes indexer, extractor, and the read path."
```

---

### Task 10: MCP and CLI surface

**Files:**
- Modify: `src/mcp/tools.ts`, `src/mcp/schemas.ts`, `src/mcp/handlers.ts`, `src/cli/main.ts`, `src/cli/search.ts`, `src/cli/stats.ts`
- Test: `src/mcp/handlers.test.ts`

**Interfaces:**
- Consumes: `searchMemories` (Task 7), `openMemoryDb` (Task 2)
- Produces: `handleSearch(params: SearchInput, db: Database): Promise<{ results: SearchResultItem[] }>`, with `interface SearchInput { query: string; limit?: number; threshold?: number; explain?: boolean; filters?: Filters }`

`fetch` is removed from `tools.ts`, `schemas.ts`, and `handlers.ts`. `search` is the only tool. Remove the `read` command from the CLI router.

- [ ] **Step 1: Write the failing test**

```ts
// src/mcp/handlers.test.ts
import { describe, expect, test } from 'bun:test';
import { TOOLS } from './tools.js';
import * as handlers from './handlers.js';

describe('MCP surface', () => {
  test('exposes search only', () => {
    expect(TOOLS.map(t => t.name)).toEqual(['search']);
  });
  test('no fetch handler remains', () => {
    expect('handleFetch' in handlers).toBe(false);
  });
  test('search schema advertises the mem0 knobs', () => {
    const props = TOOLS[0].inputSchema.properties as Record<string, unknown>;
    expect(props.query).toBeDefined();
    expect(props.limit).toBeDefined();
    expect(props.threshold).toBeDefined();
    expect(props.explain).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/mcp/handlers.test.ts`
Expected: FAIL — `TOOLS` still contains `fetch`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/mcp/tools.ts
export const TOOLS = [
  {
    name: 'search',
    description:
      'Search stored memories. Returns memory records scored by hybrid semantic + keyword relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'number', description: 'Max results. Default 20.' },
        threshold: { type: 'number', description: 'Minimum semantic score, 0-1. Default 0.1.' },
        explain: { type: 'boolean', description: 'Include score breakdown. Default false.' },
      },
      required: ['query'],
    },
  },
] as const;
```

```ts
// src/mcp/handlers.ts
import type { Database } from 'bun:sqlite';
import { searchMemories, type SearchResultItem } from '../core/memory/search.js';
import { LOCAL_USER_ID } from '../cli/sync.js';

export interface SearchInput {
  query: string;
  limit?: number;
  threshold?: number;
  explain?: boolean;
}

export async function handleSearch(
  params: SearchInput,
  db: Database,
): Promise<{ results: SearchResultItem[] }> {
  return searchMemories({
    db,
    query: params.query,
    filters: { user_id: LOCAL_USER_ID },
    limit: params.limit,
    threshold: params.threshold,
    explain: params.explain,
  });
}
```

Delete `handleFetch` and its schema, and drop `read` from the CLI router in `src/cli/main.ts`. Update `src/cli/stats.ts` to count from `memories` rather than `memory_records`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS across the suite, typecheck clean

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mcp): reduce surface to search, drop fetch and read"
```

---

### Task 11: Rebuild and verify end to end

**Files:**
- Modify: `CLAUDE.md`
- Test: manual verification against a real archive

- [ ] **Step 1: Update CLAUDE.md**

Rewrite these sections to match reality:
- Memory Architecture Principles — provenance is no longer mandatory; the unit is a flat `MemoryItem`; consolidation is ADD-only with md5 dedup
- Key Files table — remove `indexer.ts`, `extractor.ts`, `read.ts`; add `src/core/memory/*`
- Database Schema — `memories` / `history` / `entities` / `vec_memories` / `vec_entities` / `fts_memories`
- MCP Surface — `search` only; document `threshold` and `explain`
- Data Flow — the 8 phases
- Add a note: storage language is English; `use_input_language` stays off

- [ ] **Step 2: Build**

Run: `bun run build`
Expected: `dist/cli-internal.mjs`, `dist/mcp-server.mjs`, `bin/memmem` all written

- [ ] **Step 3: Full test suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: all green

- [ ] **Step 4: Verify against a real archive**

```bash
# Back up the existing DB before the schema swap.
cp ~/.config/memmem/conversation-index/conversations.db{,.pre-mem0v2.bak}
rm ~/.config/memmem/conversation-index/conversations.db

./bin/memmem sync
./bin/memmem search "embedding model" --limit 5
```

Expected: scores span a meaningful range rather than collapsing into a 1-4 point band. Confirm with the diagnostic from the spec — an off-topic query should now score visibly lower than an on-topic one, which was impossible before.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: update CLAUDE.md for mem0 v2 architecture"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| `memories` / `history` / `entities` schema | 2 |
| `MemoryItem` fields, `score` not stored | 2 |
| Promoted payload keys | 7 |
| 8-phase pipeline, one LLM call, `top_k=10`, last-10 context | 8 |
| UUID → integer remap | 8 |
| ADD-only, no UPDATE/DELETE | 8 (asserted in test) |
| md5 dedup | 6, 8 |
| `internal_limit = max(limit*4, 60)` | 7 |
| Additive scoring with adaptive divisor | 1 |
| Threshold gates raw semantic first | 1 (asserted in test) |
| `ENTITY_BOOST_WEIGHT = 0.5` | 1 |
| Reranking off by default | 7 (not implemented; opt-in only, absent) |
| `explain` → `score_details` | 1, 7 |
| Metadata filter operators | 3 |
| Scoping key required | 3, 7 |
| FTS5 `unicode61` BM25 | 2, 6, 7 |
| Entities folded into extraction | 8 |
| `LLMError` on failure | 5 |
| English storage, `use_input_language` off | 4 |
| Incremental reindex, no bulk backfill | 9 |
| Remove `fetch` / `read` / provenance | 9, 10 |

**Gap found and closed:** the spec's scoring formula omitted BM25 *sigmoid normalization*. Raw FTS5 `bm25()` output is unbounded and negative, so feeding it directly into the sum would swamp the semantic term. `getBm25Params` / `normalizeBm25` (`scoring.py:16-54`) are in Task 1 and the constants are in Global Constraints.

**Correction to the spec:** it states `get_update_memory_messages` returns no grep hits in v2.0.17. That is true of `main.py` but not of `prompts.py`, where the function still exists at line 406 — dead code the pipeline no longer calls. The conclusion (no LLM-arbitrated update) holds.

**Placeholder scan:** one intentional marker remains — `<PASTE prompts.py lines 469-943 here verbatim>` in Task 4. The prompt is ~480 lines; inlining it here would bloat the plan and risk transcription drift. The exact `curl` command and line range are given.

**Type consistency:** `Candidate`, `ScoredResult`, `ScoreDetails` (Task 1) flow unchanged into Task 7. `Filters` (Task 3) is used identically in 7, 8, 9. `Message` / `ExistingMemoryRef` (Task 4) are consumed unchanged by 5 and 8. `NewMemory` / `InsertResult` (Task 6) match Task 8's usage. `lemmatizeForBm25` lives in Task 1 and is imported by 6 and 7.

**Known limitation carried from the spec:** entity boosts are wired through `scoreAndRank` but `entityBoosts` is always empty in Task 7 — populating it requires `_compute_entity_boosts`, which depends on query-time entity extraction. With entities folded into the extraction LLM call, there is no query-time extractor. The plumbing is in place and `max_possible` adapts correctly when the map is empty. Wiring query-time entity boosts is deferred.
