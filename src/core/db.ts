import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { getDbPath } from './paths.js';
import { EMBEDDING_DIM } from './constants.js';

// @ts-ignore - import.meta.test is set by bun test
const isTestEnvironment = typeof import.meta !== 'undefined' && import.meta.test;
if (process.platform === 'darwin' && !isTestEnvironment && process.env.NODE_ENV !== 'test') {
  try {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  } catch {
  }
}

export const CURRENT_EMBEDDING_VERSION = 1;

export interface ExchangeInsert {
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  sourceKind: string;
  sessionId: string | null;
  project: string | null;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  provider: string | null;
  metadataJson: string | null;
  timestamp: number | null;
  userText: string;
  assistantText: string;
  embeddingText: string;
  embeddingVersion: number;
}

export interface ToolCallInsert {
  exchangeId: number;
  toolName: string | null;
  callId: string | null;
  input: string | null;
  output: string | null;
  status: string | null;
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
  createSchema(db);

  return db;
}

function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exchanges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      source_kind TEXT NOT NULL,
      session_id TEXT,
      project TEXT,
      cwd TEXT,
      git_branch TEXT,
      model TEXT,
      provider TEXT,
      metadata_json TEXT,
      timestamp INTEGER,
      user_text TEXT NOT NULL,
      assistant_text TEXT NOT NULL,
      embedding_text TEXT NOT NULL,
      embedding_version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(archive_path, line_start, line_end)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_exchanges_archive_path ON exchanges(archive_path)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_exchanges_source_kind ON exchanges(source_kind)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_exchanges_timestamp ON exchanges(timestamp DESC)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange_id INTEGER NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
      tool_name TEXT,
      call_id TEXT,
      input TEXT,
      output TEXT,
      status TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tool_calls_exchange_id ON tool_calls(exchange_id)');

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_exchanges USING vec0(
      embedding float[${EMBEDDING_DIM}]
    )
  `);
}

export function insertExchange(db: Database, exchange: ExchangeInsert): number {
  const now = Date.now();
  const result = db.query(`
    INSERT INTO exchanges (
      archive_path, line_start, line_end, source_kind, session_id, project, cwd,
      git_branch, model, provider, metadata_json, timestamp, user_text,
      assistant_text, embedding_text, embedding_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    exchange.archivePath,
    exchange.lineStart,
    exchange.lineEnd,
    exchange.sourceKind,
    exchange.sessionId,
    exchange.project,
    exchange.cwd,
    exchange.gitBranch,
    exchange.model,
    exchange.provider,
    exchange.metadataJson,
    exchange.timestamp,
    exchange.userText,
    exchange.assistantText,
    exchange.embeddingText,
    exchange.embeddingVersion,
    now,
    now
  );

  return result.lastInsertRowid as number;
}

export function insertToolCall(db: Database, toolCall: ToolCallInsert): number {
  const result = db.query(`
    INSERT INTO tool_calls (exchange_id, tool_name, call_id, input, output, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    toolCall.exchangeId,
    toolCall.toolName,
    toolCall.callId,
    toolCall.input,
    toolCall.output,
    toolCall.status,
    Date.now()
  );

  return result.lastInsertRowid as number;
}

export function insertExchangeVector(db: Database, exchangeId: number, embedding: number[]): void {
  db.query('INSERT OR REPLACE INTO vec_exchanges(rowid, embedding) VALUES (?, ?)')
    .run(exchangeId, Buffer.from(new Float32Array(embedding).buffer));
}

export function deleteExchangeIndexForArchivePath(db: Database, archivePath: string): void {
  const rows = db.query('SELECT id FROM exchanges WHERE archive_path = ?').all(archivePath) as Array<{ id: number }>;
  const ids = rows.map(row => row.id);

  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    db.query(`DELETE FROM vec_exchanges WHERE rowid IN (${placeholders})`).run(...ids);
  }

  db.query('DELETE FROM exchanges WHERE archive_path = ?').run(archivePath);
}

export function getArchivePathsNeedingReindex(db: Database, archivePaths: string[]): string[] {
  const paths = new Set<string>();
  const stmt = db.query(`
    SELECT COUNT(exchanges.id) AS count,
           SUM(CASE WHEN exchanges.embedding_version != ? OR vec_exchanges.rowid IS NULL THEN 1 ELSE 0 END) AS staleCount
    FROM exchanges
    LEFT JOIN vec_exchanges ON vec_exchanges.rowid = exchanges.id
    WHERE exchanges.archive_path = ?
  `);

  for (const archivePath of archivePaths) {
    const row = stmt.get(CURRENT_EMBEDDING_VERSION, archivePath) as { count: number; staleCount: number | null };
    if (row.count === 0 || (row.staleCount ?? 0) > 0) {
      paths.add(archivePath);
    }
  }

  return [...paths];
}

function throwObservationSchemaRemoved(): never {
  throw new Error('Observation schema has been removed; use exchange schema APIs instead');
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
