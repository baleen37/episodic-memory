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
