/**
 * Database Schema
 *
 * Clean slate redesign with simplified architecture:
 * - pending_events: Temporary storage for tool events before LLM extraction
 * - observations: Long-term storage for extracted insights
 * - vec_observations: Vector embeddings for semantic search
 *
 * Removed tables (no migration):
 * - exchanges (use conversation-archive directly)
 * - vec_exchanges (no longer needed)
 * - tool_calls (no longer needed)
 * - session_summaries (moved to observations)
 * - observations_fts (full-text search removed - use vector search only)
 */

import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { getDbPath } from './paths.js';
import { EMBEDDING_DIM } from './constants.js';

// macOS: Apple's default SQLite disables extensions; use Homebrew SQLite
if (process.platform === 'darwin') {
  Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
}

export interface PendingEvent {
  sessionId: string;
  project: string;
  toolName: string;
  compressed: string;
  timestamp: number;
  createdAt: number;
}

export interface Observation {
  title: string;
  content: string;
  contentOriginal?: string | null;
  project: string;
  sessionId?: string;
  timestamp: number;
  createdAt: number;
}

export interface ObservationResult {
  id: number;
  title: string;
  content: string;
  contentOriginal: string | null;
  project: string;
  sessionId: string | null;
  timestamp: number;
  createdAt: number;
}

interface SearchOptions {
  project?: string;
  sessionId?: string;
  after?: number;
  before?: number;
  limit?: number;
}

/**
 * Initialize database with schema
 * Deletes old database file if it exists (clean slate)
 */
export function initDatabase(): Database {
  return createDatabase(true);
}

/**
 * Open existing database or create new one if not exists.
 * Does not delete existing database.
 */
export function openDatabase(): Database {
  return createDatabase(false);
}

/**
 * Create or open database.
 * @param wipe Whether to delete existing database file first
 */
function createDatabase(wipe: boolean): Database {
  const dbPath = getDbPath();

  // Ensure directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Delete old database file if wipe is true (only if not in-memory)
  if (wipe && dbPath !== ':memory:' && fs.existsSync(dbPath)) {
    console.log('Deleting old database file for clean slate...');
    fs.unlinkSync(dbPath);
  }

  const db = new Database(dbPath);

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Enable WAL mode for better concurrency
  db.exec('PRAGMA journal_mode = WAL');

  // Check if tables exist, create if not
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  const tableNames = new Set(tables.map(t => t.name));

  // Create pending_events table if not exists
  if (!tableNames.has('pending_events')) {
    db.exec(`
      CREATE TABLE pending_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        compressed TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX idx_pending_session ON pending_events(session_id)`);
    db.exec(`CREATE INDEX idx_pending_project ON pending_events(project)`);
    db.exec(`CREATE INDEX idx_pending_timestamp ON pending_events(timestamp)`);
  }

  // Create observations table if not exists
  if (!tableNames.has('observations')) {
    db.exec(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        content_original TEXT,
        project TEXT NOT NULL,
        session_id TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX idx_observations_project ON observations(project)`);
    db.exec(`CREATE INDEX idx_observations_session ON observations(session_id)`);
    db.exec(`CREATE INDEX idx_observations_timestamp ON observations(timestamp DESC)`);
  }

  // Upgrade observations schema for existing databases
  // Add content_original column if missing
  const observationColumns = db.query(`
    SELECT name FROM pragma_table_info('observations')
  `).all() as Array<{ name: string }>;
  const hasContentOriginal = observationColumns.some(
    column => column.name.toLowerCase() === 'content_original'
  );
  if (!hasContentOriginal) {
    db.exec(`ALTER TABLE observations ADD COLUMN content_original TEXT`);
  }

  // Migration: check if vec_observations has wrong dimension (768 -> 384)
  if (tableNames.has('vec_observations')) {
    const schemaResult = db.query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_observations'"
    ).get() as { sql: string } | undefined;

    if (schemaResult?.sql?.includes('float[768]')) {
      console.log('Migrating vec_observations from 768-dim to 384-dim (embeddings will be re-indexed)...');
      db.exec(`DROP TABLE IF EXISTS vec_observations`);
      tableNames.delete('vec_observations');
    }
  }

  // Create vector table if not exists
  if (!tableNames.has('vec_observations')) {
    db.exec(`
      CREATE VIRTUAL TABLE vec_observations USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${EMBEDDING_DIM}]
      )
    `);
  }

  return db;
}

/**
 * Insert a pending event into the database
 */
export function insertPendingEvent(
  db: Database,
  event: PendingEvent
): number {
  const result = db.query(`
    INSERT INTO pending_events (session_id, project, tool_name, compressed, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    event.sessionId,
    event.project,
    event.toolName,
    event.compressed,
    event.timestamp,
    event.createdAt
  );

  return result.lastInsertRowid as number;
}

/**
 * Insert an observation into the database
 * Optionally includes vector embedding for semantic search
 */
export function insertObservation(
  db: Database,
  observation: Observation,
  embedding?: number[]
): number {
  // Insert into main table
  const result = db.query(`
    INSERT INTO observations (title, content, content_original, project, session_id, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    observation.title,
    observation.content,
    observation.contentOriginal ?? null,
    observation.project,
    observation.sessionId ?? null,
    observation.timestamp,
    observation.createdAt
  );

  const rowid = result.lastInsertRowid as number;

  // Insert into vector table if embedding provided
  // Use the string id to link the tables
  if (embedding) {
    db.query(`
      INSERT INTO vec_observations (id, embedding)
      VALUES (?, ?)
    `).run(String(rowid), Buffer.from(new Float32Array(embedding).buffer));
  }

  return rowid;
}

/**
 * Get all pending events for a session (no limit).
 * Used by Stop hook for batch extraction.
 */
export function getAllPendingEvents(
  db: Database,
  sessionId: string
): Array<PendingEvent & { id: number }> {
  return db.query(`
    SELECT id, session_id as sessionId, project, tool_name as toolName, compressed, timestamp, created_at as createdAt
    FROM pending_events
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(sessionId) as Array<PendingEvent & { id: number }>;
}

/**
 * Search observations with filters
 */
export function searchObservations(
  db: Database,
  options: SearchOptions = {}
): ObservationResult[] {
  const { project, sessionId, after, before, limit = 100 } = options;

  const params: any[] = [];

  // Build query with optional filters
  let sql = `
    SELECT id, title, content, content_original as contentOriginal, project, session_id as sessionId, timestamp, created_at as createdAt
    FROM observations
    WHERE 1=1
  `;

  if (project) {
    sql += ' AND project = ?';
    params.push(project);
  }

  if (sessionId) {
    sql += ' AND session_id = ?';
    params.push(sessionId);
  }

  if (after) {
    sql += ' AND timestamp >= ?';
    params.push(after);
  }

  if (before) {
    sql += ' AND timestamp <= ?';
    params.push(before);
  }

  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  return db.query(sql).all(...params) as ObservationResult[];
}

/**
 * Get a single observation by ID
 */
export function getObservation(
  db: Database,
  id: number
): ObservationResult | null {
  const result = db.query(`
    SELECT id, title, content, content_original as contentOriginal, project, session_id as sessionId, timestamp, created_at as createdAt
    FROM observations
    WHERE id = ?
  `).get(id) as ObservationResult | undefined;

  return result ?? null;
}
