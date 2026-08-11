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
  const remapped: ExistingMemoryRef[] = existingMemories.map((m, i) => ({ id: String(i), text: m.text }));

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
