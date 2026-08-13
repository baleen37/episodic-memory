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

const VECTOR_DIMENSION = 384;
const SCOPES = new Set(['local', 'team-alpha', 'team-beta', 'archived']);
const CASES = new Set<SearchQualityQuery['case']>([
  'cross-lingual',
  'rare-token',
  'partial-match',
  'distractor',
  'scope',
  'recency',
  'semantic-only',
  'lexical-only',
]);
const EXPECTED_CORPUS_IDS = new Set([
  ...Array.from({ length: 24 }, (_, index) => `memory-${String(index + 1).padStart(3, '0')}`),
  ...Array.from({ length: 72 }, (_, index) => `distractor-${String(index + 1).padStart(3, '0')}`),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateVector(vector: unknown, label: string): asserts vector is number[] {
  if (!Array.isArray(vector) || vector.length !== VECTOR_DIMENSION || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`invalid embedding dimension for ${label}`);
  }
}

export function validateSearchQualityFixture(corpus: unknown, queries: unknown): SearchQualityFixture {
  if (!Array.isArray(corpus) || !Array.isArray(queries)) {
    throw new Error('fixture corpus and queries must be arrays');
  }

  const corpusIds = new Set<string>();
  const validatedCorpus = corpus.map((row): SearchQualityCorpusRow => {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      throw new Error('invalid corpus row');
    }
    if (corpusIds.has(row.id)) {
      throw new Error(`duplicate corpus id: ${row.id}`);
    }
    corpusIds.add(row.id);
    if (typeof row.memory !== 'string' || row.memory.length === 0) {
      throw new Error(`invalid memory for corpus row: ${row.id}`);
    }
    if (!isRecord(row.metadata) || typeof row.metadata.user_id !== 'string' || row.metadata.user_id.length === 0) {
      throw new Error(`missing user_id for corpus row: ${row.id}`);
    }
    if (!SCOPES.has(row.metadata.user_id)) {
      throw new Error(`invalid user_id scope for corpus row: ${row.id}`);
    }
    validateVector(row.embedding, `corpus row: ${row.id}`);
    return row as unknown as SearchQualityCorpusRow;
  });

  if (validatedCorpus.length !== 96) {
    throw new Error('expected 96 corpus rows');
  }
  for (const id of EXPECTED_CORPUS_IDS) {
    if (!corpusIds.has(id)) {
      throw new Error(`missing required corpus id: ${id}`);
    }
  }

  const validatedQueries = queries.map((query): SearchQualityQuery => {
    if (!isRecord(query) || typeof query.query !== 'string' || query.query.length === 0) {
      throw new Error('invalid query');
    }
    if (!CASES.has(query.case as SearchQualityQuery['case'])) {
      throw new Error(`invalid case for query: ${query.query}`);
    }
    if (!isRecord(query.filters) || typeof query.filters.user_id !== 'string' || query.filters.user_id.length === 0) {
      throw new Error(`missing user_id filter for query: ${query.query}`);
    }
    if (!SCOPES.has(query.filters.user_id)) {
      throw new Error(`invalid user_id scope for query: ${query.query}`);
    }
    validateVector(query.queryEmbedding, `query: ${query.query}`);
    if (!isRecord(query.relevance)) {
      throw new Error(`invalid relevance for query: ${query.query}`);
    }
    for (const [id, relevance] of Object.entries(query.relevance)) {
      if (!corpusIds.has(id)) {
        throw new Error(`unknown judgment id for query: ${query.query}`);
      }
      if (relevance !== 1 && relevance !== 2 && relevance !== 3) {
        throw new Error(`invalid relevance for query: ${query.query}`);
      }
      const row = validatedCorpus.find((candidate) => candidate.id === id);
      if (row?.metadata.user_id !== query.filters.user_id) {
        throw new Error(`out-of-scope judgment id for query: ${query.query}`);
      }
    }
    return query as unknown as SearchQualityQuery;
  });

  if (validatedQueries.length !== 40) {
    throw new Error('expected 40 queries');
  }
  for (const caseName of CASES) {
    if (validatedQueries.filter((query) => query.case === caseName).length !== 5) {
      throw new Error(`expected 5 queries for case: ${caseName}`);
    }
  }
  if (validatedQueries.filter((query) => Object.keys(query.relevance).length === 0).length !== 5) {
    throw new Error('expected 5 empty expected-result queries');
  }

  return { corpus: validatedCorpus, queries: validatedQueries };
}

export async function loadSearchQualityFixture(): Promise<SearchQualityFixture> {
  const corpusPath = `${import.meta.dir}/../tests/fixtures/search-quality-corpus.json`;
  const queriesPath = `${import.meta.dir}/../tests/fixtures/search-quality-queries.json`;
  const [corpus, queries] = await Promise.all([
    Bun.file(corpusPath).json(),
    Bun.file(queriesPath).json(),
  ]);
  return validateSearchQualityFixture(corpus, queries);
}
