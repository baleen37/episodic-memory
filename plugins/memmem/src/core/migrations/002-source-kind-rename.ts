import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, sep } from 'path';
import type { Migration } from './types.js';

const RENAMES = [
  { oldKind: 'claude-projects', newKind: 'claude-code-projects' },
  { oldKind: 'claude-transcripts', newKind: 'claude-code-transcripts' },
] as const;

function rewriteArchivePath(archivePath: string, oldKind: string, newKind: string): string {
  const oldSegment = `${sep}${oldKind}${sep}`;
  const index = archivePath.indexOf(oldSegment);
  if (index < 0) return archivePath;
  return `${archivePath.slice(0, index)}${sep}${newKind}${sep}${archivePath.slice(index + oldSegment.length)}`;
}

function moveArchiveFile(oldPath: string, newPath: string): void {
  if (oldPath === newPath || !existsSync(oldPath) || existsSync(newPath)) {
    return;
  }
  mkdirSync(dirname(newPath), { recursive: true });
  renameSync(oldPath, newPath);
}

function rewriteTableArchivePaths(db: Database, table: string, oldKind: string, newKind: string): void {
  const rows = db.query(`
    SELECT DISTINCT archive_path AS archivePath
    FROM ${table}
    WHERE archive_path LIKE ?
  `).all(`%${sep}${oldKind}${sep}%`) as Array<{ archivePath: string }>;
  const update = db.prepare(`UPDATE ${table} SET archive_path = ? WHERE archive_path = ?`);

  for (const { archivePath } of rows) {
    const newArchivePath = rewriteArchivePath(archivePath, oldKind, newKind);
    moveArchiveFile(archivePath, newArchivePath);
    update.run(newArchivePath, archivePath);
  }
}

function rewriteSourceKind(db: Database, table: string, oldKind: string, newKind: string): void {
  db.query(`UPDATE ${table} SET source_kind = ? WHERE source_kind = ?`).run(newKind, oldKind);
}

export const sourceKindRenameMigration: Migration = {
  version: 2,
  name: 'source-kind-rename',
  up(db: Database): void {
    const run = db.transaction(() => {
      for (const { oldKind, newKind } of RENAMES) {
        rewriteTableArchivePaths(db, 'memory_records', oldKind, newKind);
        rewriteTableArchivePaths(db, 'extraction_state', oldKind, newKind);
        rewriteTableArchivePaths(db, 'archive_index_state', oldKind, newKind);
        rewriteSourceKind(db, 'memory_records', oldKind, newKind);
        rewriteSourceKind(db, 'extraction_state', oldKind, newKind);
      }
    });
    run();
  },
};
