import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'crypto';
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

export interface EntityLink {
  data: string;
  entity_type: string | null;
  memory_ids: string[];
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

/**
 * Deletes every memory whose metadata.run_id is in `runIds`, along with its vector
 * and FTS rows. Returns the number of memories deleted.
 *
 * Ordering matters: SQLite reuses freed rowids, so a stale vec_memories/fts_memories
 * row left behind after a memories row is deleted would later be silently
 * misattributed to an unrelated new memory that happens to get the same rowid. To
 * avoid that, resolve the target rowids first, delete the vec_memories and
 * fts_memories rows by rowid, and only then delete the memories rows — all inside
 * one transaction.
 */
export function deleteMemoriesByRunIds(db: Database, runIds: string[]): number {
  if (runIds.length === 0) return 0;

  const placeholders = runIds.map(() => '?').join(',');
  const rows = db.query(
    `SELECT rowid AS r, id FROM memories WHERE json_extract(metadata, '$.run_id') IN (${placeholders})`,
  ).all(...runIds) as Array<{ r: number; id: string }>;
  const rowids = rows.map(row => row.r);
  if (rowids.length === 0) return 0;
  const deletedIds = new Set(rows.map(row => row.id));

  const rowidPlaceholders = rowids.map(() => '?').join(',');
  const deleteVec = db.query(`DELETE FROM vec_memories WHERE rowid IN (${rowidPlaceholders})`);
  const deleteFts = db.query(`DELETE FROM fts_memories WHERE rowid IN (${rowidPlaceholders})`);
  const deleteMemories = db.query(`DELETE FROM memories WHERE rowid IN (${rowidPlaceholders})`);

  db.transaction(() => {
    deleteVec.run(...rowids);
    deleteFts.run(...rowids);
    deleteMemories.run(...rowids);
    removeMemoriesFromEntities(db, deletedIds);
  })();

  return rowids.length;
}

/**
 * Port of upstream `_remove_memory_from_entity_store`: strip deleted memory ids
 * from every entity's linked_memory_ids; an entity left with no links is
 * deleted along with its vector row (same rowid-reuse ordering concern as above).
 */
function removeMemoriesFromEntities(db: Database, deletedIds: Set<string>): void {
  const entities = db.query('SELECT rowid AS r, linked_memory_ids AS l FROM entities')
    .all() as Array<{ r: number; l: string }>;
  const update = db.query('UPDATE entities SET linked_memory_ids = ? WHERE rowid = ?');
  const deleteVec = db.query('DELETE FROM vec_entities WHERE rowid = ?');
  const deleteEntity = db.query('DELETE FROM entities WHERE rowid = ?');

  for (const entity of entities) {
    const linked = JSON.parse(entity.l) as string[];
    const remaining = linked.filter(id => !deletedIds.has(id));
    if (remaining.length === linked.length) continue;
    if (remaining.length === 0) {
      deleteVec.run(entity.r);
      deleteEntity.run(entity.r);
    } else {
      update.run(JSON.stringify(remaining), entity.r);
    }
  }
}

/** Same normalization as upstream `_normalize_entity_text`. */
export function normalizeEntityText(value: string): string {
  return value.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/** Match threshold for merging a new entity into an existing one (upstream: score >= 0.95). */
const ENTITY_SEMANTIC_MATCH_THRESHOLD = 0.95;

interface ScopedEntityRow {
  r: number;
  data: string;
  linked_memory_ids: string;
}

/** Similarity under the port's `1 - distance` convention (search.ts uses the same). */
function entitySimilarity(a: number[], b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < b.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return 1 - Math.sqrt(sum);
}

/**
 * Port of mem0 Phase 7c-7e (main.py:1126-1180): for each entity (already
 * globally deduplicated by normalized text), merge into an existing entity in
 * the same scope — exact normalized-text match first, then semantic match at
 * >= 0.95 — or insert a new entity row plus its vector.
 *
 * Like upstream, matching runs only against pre-existing rows: entities
 * inserted by this same call are not merge candidates for each other
 * (upstream batches its inserts after all match checks).
 */
export function linkEntities(db: Database, entities: EntityLink[], scope: Record<string, unknown>): void {
  if (entities.length === 0) return;

  const scopeEntries = Object.entries(scope).filter(([, v]) => v !== undefined && v !== null);
  const scopeClause = scopeEntries.map(() => 'json_extract(metadata, ?) = ?').join(' AND ');
  const scopeParams = scopeEntries.flatMap(([k, v]) => [`$.${k}`, String(v)]);

  const scoped = db.query(
    `SELECT rowid AS r, data, linked_memory_ids FROM entities${scopeClause ? ` WHERE ${scopeClause}` : ''}`,
  ).all(...scopeParams) as ScopedEntityRow[];

  const byNormalized = new Map<string, ScopedEntityRow>();
  for (const row of scoped) {
    const normalized = normalizeEntityText(row.data);
    if (normalized && !byNormalized.has(normalized)) byNormalized.set(normalized, row);
  }

  const selectVec = db.query('SELECT embedding FROM vec_entities WHERE rowid = ?');
  const vectorOf = (rowid: number): Float32Array | null => {
    const row = selectVec.get(rowid) as { embedding: Uint8Array } | null;
    if (!row) return null;
    const buf = row.embedding;
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  };

  const update = db.query('UPDATE entities SET linked_memory_ids = ? WHERE rowid = ?');
  const insert = db.query(
    'INSERT INTO entities (id, data, entity_type, linked_memory_ids, metadata, created_at) VALUES (?,?,?,?,?,?)',
  );
  const selectRowid = db.query('SELECT rowid AS r FROM entities WHERE id = ?');
  const insertVec = db.query('INSERT INTO vec_entities(rowid, embedding) VALUES (?, ?)');
  const now = Date.now();
  const metadataJson = JSON.stringify(Object.fromEntries(scopeEntries));

  db.transaction(() => {
    for (const entity of entities) {
      const normalized = normalizeEntityText(entity.data);
      if (!normalized) continue;

      let match = byNormalized.get(normalized) ?? null;
      if (!match) {
        for (const row of scoped) {
          const vec = vectorOf(row.r);
          if (vec && entitySimilarity(entity.embedding, vec) >= ENTITY_SEMANTIC_MATCH_THRESHOLD) {
            match = row;
            break;
          }
        }
      }

      if (match) {
        const merged = Array.from(new Set([
          ...JSON.parse(match.linked_memory_ids) as string[],
          ...entity.memory_ids,
        ])).sort();
        match.linked_memory_ids = JSON.stringify(merged);
        update.run(match.linked_memory_ids, match.r);
        continue;
      }

      const id = randomUUID();
      insert.run(id, entity.data, entity.entity_type, JSON.stringify([...entity.memory_ids].sort()), metadataJson, now);
      const rowid = (selectRowid.get(id) as { r: number }).r;
      insertVec.run(rowid, Buffer.from(new Float32Array(entity.embedding).buffer));
    }
  })();
}
