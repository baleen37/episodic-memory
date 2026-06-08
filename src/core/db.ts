import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { getDbPath } from './paths.js';
import { EMBEDDING_DIM } from './constants.js';
import { runMigrations } from './migrations/index.js';

// @ts-ignore - import.meta.test is set by bun test
const isTestEnvironment = typeof import.meta !== 'undefined' && import.meta.test;
if (process.platform === 'darwin' && !isTestEnvironment && process.env.NODE_ENV !== 'test') {
  try {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  } catch {
  }
}

export const CURRENT_EMBEDDING_VERSION = 2;
export const CURRENT_EXTRACTION_VERSION = 1;

export type MemoryRecordKind = 'fact' | 'event';
export type MemoryRecordStatus = 'active' | 'superseded';
export type ExtractionStatus = 'done' | 'empty' | 'errored';

export interface MemoryRecordInsert {
  kind: MemoryRecordKind;
  text: string;
  sourceKind: string;
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  observedAt: number | null;
  project: string | null;
  projectName: string | null;
  confidence?: number;
  status?: MemoryRecordStatus;
  supersedesId?: number | null;
  dedupeKey: string;
  extractionVersion: number;
  embeddingVersion?: number | null;
}

export interface ExtractionStateInsert {
  sourceKind: string;
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  sourceHash: string;
  extractionVersion: number;
  status: ExtractionStatus;
  errorMessage?: string | null;
  retryAfter?: number | null;
  attemptCount?: number;
}

export interface PendingEvent {
  sessionId: string;
  project: string;
  toolName: string;
  summary: string;
  timestamp: number;
  createdAt: number;
}

export interface Observation {
  id: number;
  title: string;
  content: string;
  contentOriginal: string | null;
  project: string;
  sessionId: string | null;
  timestamp: number;
  createdAt: number;
}

interface RecentObservationsOptions {
  project?: string;
  after?: number;
  limit?: number;
}

interface SearchOptions {
  project?: string;
  sessionId?: string;
  after?: number;
  before?: number;
  limit?: number;
}

export function initDatabase(): Database {
  return createDatabase(true);
}

export function openDatabase(): Database {
  return createDatabase(false);
}

function createDatabase(wipe: boolean): Database {
  const dbPath = getDbPath();
  const dbDir = path.dirname(dbPath);

  if (dbPath !== ':memory:' && !fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (wipe && dbPath !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) {
      const filePath = `${dbPath}${suffix}`;
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  }

  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  createSchema(db);

  return db;
}

function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('fact', 'event')),
      text TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      observed_at INTEGER,
      project TEXT,
      project_name TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
      supersedes_id INTEGER,
      dedupe_key TEXT NOT NULL,
      extraction_version INTEGER NOT NULL,
      embedding_version INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec('DROP INDEX IF EXISTS idx_memory_records_dedupe_key');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_records_dedupe_key ON memory_records(dedupe_key, archive_path, line_start, line_end)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_records_kind ON memory_records(kind)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_records_status ON memory_records(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_records_archive_path ON memory_records(archive_path)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memory_records_observed_at ON memory_records(observed_at)');

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory_records USING vec0(
      embedding float[${EMBEDDING_DIM}]
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_kind TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      source_hash TEXT NOT NULL,
      extraction_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('done', 'empty', 'errored')),
      error_message TEXT,
      retry_after INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(archive_path, line_start, line_end, source_hash, extraction_version)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_extraction_state_archive_path ON extraction_state(archive_path)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_extraction_state_status ON extraction_state(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_extraction_state_retry_after ON extraction_state(retry_after)');
  migrateExtractionState(db);
  runMigrations(db);
}

function migrateExtractionState(db: Database): void {
  const cols = db
    .query('PRAGMA table_info(extraction_state)')
    .all() as Array<{ name: string }>;
  const hasAttemptCount = cols.some((c) => c.name === 'attempt_count');
  if (!hasAttemptCount) {
    db.exec(
      'ALTER TABLE extraction_state ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0',
    );
  }
}

// Test-only export
export function migrateExtractionStateForTests(db: Database): void {
  migrateExtractionState(db);
}

export function insertMemoryRecord(db: Database, record: MemoryRecordInsert): number {
  const now = Date.now();
  db.query(`
    INSERT INTO memory_records (
      kind, text, source_kind, archive_path, line_start, line_end,
      observed_at, project, project_name, confidence, status, supersedes_id,
      dedupe_key, extraction_version, embedding_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key, archive_path, line_start, line_end) DO UPDATE SET
      kind = excluded.kind,
      text = excluded.text,
      source_kind = excluded.source_kind,
      observed_at = excluded.observed_at,
      project = excluded.project,
      project_name = excluded.project_name,
      confidence = excluded.confidence,
      status = excluded.status,
      supersedes_id = excluded.supersedes_id,
      extraction_version = excluded.extraction_version,
      embedding_version = excluded.embedding_version,
      updated_at = excluded.updated_at
  `).run(
    record.kind,
    record.text,
    record.sourceKind,
    record.archivePath,
    record.lineStart,
    record.lineEnd,
    record.observedAt,
    record.project,
    record.projectName,
    record.confidence ?? 1.0,
    record.status ?? 'active',
    record.supersedesId ?? null,
    record.dedupeKey,
    record.extractionVersion,
    record.embeddingVersion ?? null,
    now,
    now,
  );

  const row = db.query(`
    SELECT id FROM memory_records
    WHERE dedupe_key = ? AND archive_path = ? AND line_start = ? AND line_end = ?
  `).get(record.dedupeKey, record.archivePath, record.lineStart, record.lineEnd) as { id: number } | null;
  if (!row) throw new Error(`Failed to resolve memory record for scoped dedupe key: ${record.dedupeKey}`);
  return row.id;
}

export function insertMemoryRecordVector(db: Database, memoryRecordId: number, embedding: number[]): void {
  db.query('DELETE FROM vec_memory_records WHERE rowid = ?').run(memoryRecordId);
  db.query('INSERT INTO vec_memory_records(rowid, embedding) VALUES (?, ?)')
    .run(memoryRecordId, Buffer.from(new Float32Array(embedding).buffer));
}

export function deleteMemoryIndexForArchivePath(db: Database, archivePath: string): void {
  const rows = db.query('SELECT id FROM memory_records WHERE archive_path = ?').all(archivePath) as Array<{ id: number }>;
  const ids = rows.map(row => row.id);

  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    db.query(`DELETE FROM vec_memory_records WHERE rowid IN (${placeholders})`).run(...ids);
  }

  db.query('DELETE FROM memory_records WHERE archive_path = ?').run(archivePath);
  db.query('DELETE FROM extraction_state WHERE archive_path = ?').run(archivePath);
}

export function deleteMemoryIndexForArchivePathPrefix(db: Database, archivePathPrefix: string): void {
  const childPrefix = `${archivePathPrefix}${path.sep}%`;
  const rows = db.query('SELECT id FROM memory_records WHERE archive_path = ? OR archive_path LIKE ?')
    .all(archivePathPrefix, childPrefix) as Array<{ id: number }>;
  const ids = rows.map(row => row.id);

  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    db.query(`DELETE FROM vec_memory_records WHERE rowid IN (${placeholders})`).run(...ids);
  }

  db.query('DELETE FROM memory_records WHERE archive_path = ? OR archive_path LIKE ?').run(archivePathPrefix, childPrefix);
  db.query('DELETE FROM extraction_state WHERE archive_path = ? OR archive_path LIKE ?').run(archivePathPrefix, childPrefix);
}

export function upsertExtractionState(db: Database, state: ExtractionStateInsert): void {
  const now = Date.now();
  db.query(`
    INSERT INTO extraction_state (
      source_kind, archive_path, line_start, line_end, source_hash,
      extraction_version, status, error_message, retry_after, attempt_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(archive_path, line_start, line_end, source_hash, extraction_version)
    DO UPDATE SET
      source_kind = excluded.source_kind,
      status = excluded.status,
      error_message = excluded.error_message,
      retry_after = excluded.retry_after,
      attempt_count = excluded.attempt_count,
      updated_at = excluded.updated_at
  `).run(
    state.sourceKind,
    state.archivePath,
    state.lineStart,
    state.lineEnd,
    state.sourceHash,
    state.extractionVersion,
    state.status,
    state.errorMessage ?? null,
    state.retryAfter ?? null,
    state.attemptCount ?? 0,
    now,
    now,
  );
}

export function getExtractionAttemptCount(
  db: Database,
  archivePath: string,
  lineStart: number,
  lineEnd: number,
  sourceHash: string,
  extractionVersion: number,
): number {
  const row = db.query(`
    SELECT attempt_count AS attemptCount FROM extraction_state
    WHERE archive_path = ? AND line_start = ? AND line_end = ?
      AND source_hash = ? AND extraction_version = ?
  `).get(archivePath, lineStart, lineEnd, sourceHash, extractionVersion) as
    | { attemptCount: number }
    | null;
  return row?.attemptCount ?? 0;
}

export function hasCompletedExtractionState(
  db: Database,
  archivePath: string,
  lineStart: number,
  lineEnd: number,
  sourceHash: string,
  extractionVersion: number,
): boolean {
  const row = db.query(`
    SELECT status FROM extraction_state
    WHERE archive_path = ? AND line_start = ? AND line_end = ?
      AND source_hash = ? AND extraction_version = ?
  `).get(archivePath, lineStart, lineEnd, sourceHash, extractionVersion) as { status: string } | null;
  return row?.status === 'done' || row?.status === 'empty';
}

function throwObservationSchemaRemoved(): never {
  throw new Error('Observation schema has been removed; use memory record schema APIs instead');
}

export function insertPendingEvent(db: Database, event: PendingEvent): number {
  void db;
  void event;
  throwObservationSchemaRemoved();
}

export function insertObservation(
  db: Database,
  observation: Omit<Observation, 'id' | 'contentOriginal' | 'sessionId'> & {
    contentOriginal?: string | null;
    sessionId?: string | null;
  },
  embedding?: number[]
): number {
  void db;
  void observation;
  void embedding;
  throwObservationSchemaRemoved();
}

export async function createObservation(
  db: Database,
  title: string,
  content: string,
  project: string,
  sessionId?: string,
  timestamp?: number,
  contentOriginal?: string
): Promise<number> {
  void db;
  void title;
  void content;
  void project;
  void sessionId;
  void timestamp;
  void contentOriginal;
  throwObservationSchemaRemoved();
}

export function getAllPendingEvents(
  db: Database,
  sessionId: string
): Array<PendingEvent & { id: number }> {
  void db;
  void sessionId;
  throwObservationSchemaRemoved();
}

export function getRecentObservations(
  db: Database,
  options: RecentObservationsOptions = {}
): Observation[] {
  void db;
  void options;
  throwObservationSchemaRemoved();
}

export function searchObservations(
  db: Database,
  options: SearchOptions = {}
): Observation[] {
  void db;
  void options;
  throwObservationSchemaRemoved();
}

export function getObservationById(
  db: Database,
  id: number
): Observation | null {
  void db;
  void id;
  throwObservationSchemaRemoved();
}

export function getObservation(
  db: Database,
  id: number
): Observation | null {
  return getObservationById(db, id);
}

export function getObservationsByIds(db: Database, ids: number[]): Observation[] {
  void db;
  void ids;
  throwObservationSchemaRemoved();
}
