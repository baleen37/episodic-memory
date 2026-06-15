import type { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import type { Migration } from './types.js';
import { resolveProject } from '../project.js';

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

// Extract the first cwd found in an archived transcript:
// Claude lines carry top-level `cwd`; Codex lines carry `payload.cwd`.
function readCwdFromArchive(archivePath: string): string | null {
  let content: string;
  try {
    content = readFileSync(archivePath, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } };
      const cwd = typeof obj.cwd === 'string' ? obj.cwd
        : typeof obj.payload?.cwd === 'string' ? obj.payload.cwd
        : null;
      if (cwd) return cwd;
    } catch {
      // skip malformed line
    }
  }
  return null;
}

export const projectColumnsMigration: Migration = {
  version: 1,
  name: 'project-columns',
  up(db: Database): void {
    const run = db.transaction(() => {
      if (!hasColumn(db, 'memory_records', 'project_name')) {
        db.exec('ALTER TABLE memory_records ADD COLUMN project_name TEXT');
      }

      const paths = db
        .query(
          `SELECT DISTINCT archive_path AS p FROM memory_records
           WHERE status = 'active' AND project IS NULL`,
        )
        .all() as Array<{ p: string }>;

      const update = db.prepare(
        `UPDATE memory_records SET project = ?, project_name = ?
         WHERE archive_path = ? AND project IS NULL`,
      );

      for (const { p } of paths) {
        const cwd = readCwdFromArchive(p);
        const { project, projectName } = resolveProject(cwd);
        update.run(project, projectName, p);
      }
    });
    run();
  },
};
