import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sourceKindRenameMigration } from './002-source-kind-rename.js';

function oldDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memory_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE extraction_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_kind TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      source_hash TEXT NOT NULL,
      extraction_version INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE archive_index_state (
      archive_path TEXT PRIMARY KEY,
      content_mtime_ms REAL NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

describe('sourceKindRenameMigration', () => {
  test('renames legacy Claude source kinds and archive paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memmem-source-kind-'));
    try {
      const oldProjectArchive = join(dir, 'conversation-archive', 'claude-projects', 'proj', 'session.jsonl');
      const newProjectArchive = join(dir, 'conversation-archive', 'claude-code-projects', 'proj', 'session.jsonl');
      const oldTranscriptArchive = join(dir, 'conversation-archive', 'claude-transcripts', 'session.jsonl');
      const newTranscriptArchive = join(dir, 'conversation-archive', 'claude-code-transcripts', 'session.jsonl');
      const codexArchive = join(dir, 'conversation-archive', 'codex-sessions', 'rollout.jsonl');
      mkdirSync(join(dir, 'conversation-archive', 'claude-projects', 'proj'), { recursive: true });
      mkdirSync(join(dir, 'conversation-archive', 'claude-transcripts'), { recursive: true });
      mkdirSync(join(dir, 'conversation-archive', 'codex-sessions'), { recursive: true });
      writeFileSync(oldProjectArchive, '{}\n');
      writeFileSync(oldTranscriptArchive, '{}\n');
      writeFileSync(codexArchive, '{}\n');

      const db = oldDb();
      db.query(`
        INSERT INTO memory_records
          (kind, text, source_kind, archive_path, line_start, line_end, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('fact', 'project memory', 'claude-projects', oldProjectArchive, 1, 2, 'active');
      db.query(`
        INSERT INTO memory_records
          (kind, text, source_kind, archive_path, line_start, line_end, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('fact', 'transcript memory', 'claude-transcripts', oldTranscriptArchive, 1, 1, 'active');
      db.query(`
        INSERT INTO memory_records
          (kind, text, source_kind, archive_path, line_start, line_end, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('fact', 'codex memory', 'codex-sessions', codexArchive, 1, 1, 'active');
      db.query(`
        INSERT INTO extraction_state
          (source_kind, archive_path, line_start, line_end, source_hash, extraction_version, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('claude-projects', oldProjectArchive, 1, 2, 'hash-a', 1, 'done');
      db.query(`
        INSERT INTO extraction_state
          (source_kind, archive_path, line_start, line_end, source_hash, extraction_version, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('claude-transcripts', oldTranscriptArchive, 1, 1, 'hash-b', 1, 'empty');
      db.query('INSERT INTO archive_index_state (archive_path, content_mtime_ms, updated_at) VALUES (?, ?, ?)')
        .run(oldProjectArchive, 123, 456);
      db.query('INSERT INTO archive_index_state (archive_path, content_mtime_ms, updated_at) VALUES (?, ?, ?)')
        .run(oldTranscriptArchive, 789, 111);

      sourceKindRenameMigration.up(db);
      sourceKindRenameMigration.up(db);

      const memoryRows = db.query(`
        SELECT text, source_kind AS sourceKind, archive_path AS archivePath
        FROM memory_records ORDER BY id
      `).all() as Array<{ text: string; sourceKind: string; archivePath: string }>;
      const stateRows = db.query(`
        SELECT source_kind AS sourceKind, archive_path AS archivePath
        FROM extraction_state ORDER BY id
      `).all() as Array<{ sourceKind: string; archivePath: string }>;
      const indexedPaths = db.query(`
        SELECT archive_path AS archivePath FROM archive_index_state ORDER BY archive_path
      `).all() as Array<{ archivePath: string }>;

      expect(memoryRows).toEqual([
        { text: 'project memory', sourceKind: 'claude-code-projects', archivePath: newProjectArchive },
        { text: 'transcript memory', sourceKind: 'claude-code-transcripts', archivePath: newTranscriptArchive },
        { text: 'codex memory', sourceKind: 'codex-sessions', archivePath: codexArchive },
      ]);
      expect(stateRows).toEqual([
        { sourceKind: 'claude-code-projects', archivePath: newProjectArchive },
        { sourceKind: 'claude-code-transcripts', archivePath: newTranscriptArchive },
      ]);
      expect(indexedPaths.map(row => row.archivePath)).toEqual([newProjectArchive, newTranscriptArchive]);
      expect(existsSync(newProjectArchive)).toBe(true);
      expect(existsSync(newTranscriptArchive)).toBe(true);
      expect(existsSync(oldProjectArchive)).toBe(false);
      expect(existsSync(oldTranscriptArchive)).toBe(false);

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
