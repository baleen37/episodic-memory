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
    `SELECT rowid AS r FROM memories WHERE json_extract(metadata, '$.run_id') IN (${placeholders})`,
  ).all(...runIds) as Array<{ r: number }>;
  const rowids = rows.map(row => row.r);
  if (rowids.length === 0) return 0;

  const rowidPlaceholders = rowids.map(() => '?').join(',');
  const deleteVec = db.query(`DELETE FROM vec_memories WHERE rowid IN (${rowidPlaceholders})`);
  const deleteFts = db.query(`DELETE FROM fts_memories WHERE rowid IN (${rowidPlaceholders})`);
  const deleteMemories = db.query(`DELETE FROM memories WHERE rowid IN (${rowidPlaceholders})`);

  db.transaction(() => {
    deleteVec.run(...rowids);
    deleteFts.run(...rowids);
    deleteMemories.run(...rowids);
  })();

  return rowids.length;
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
