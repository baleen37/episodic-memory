import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { projectColumnsMigration } from './001-project-columns.js';

// Build a pre-migration memory_records table WITHOUT project_name and with project NULL.
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
      project TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);
  return db;
}

test('adds project_name column and backfills from archived JSONL cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memmem-mig-'));
  const claudePath = join(dir, 'claude.jsonl');
  writeFileSync(
    claudePath,
    [
      JSON.stringify({ type: 'summary' }),
      JSON.stringify({ type: 'user', cwd: '/Users/me/dev/acme/widget/.worktrees/00001-x', message: {} }),
    ].join('\n'),
  );
  const codexPath = join(dir, 'codex.jsonl');
  writeFileSync(
    codexPath,
    [
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/me/dev/acme/gadget' } }),
    ].join('\n'),
  );

  const db = oldDb();
  const ins = db.prepare(
    'INSERT INTO memory_records (kind, text, source_kind, archive_path, line_start, line_end, project, status) VALUES (?,?,?,?,?,?,?,?)',
  );
  ins.run('fact', 't1', 'claude-projects', claudePath, 1, 2, null, 'active');
  ins.run('fact', 't2', 'claude-projects', claudePath, 3, 4, null, 'active');
  ins.run('fact', 't3', 'codex-sessions', codexPath, 1, 1, null, 'active');

  projectColumnsMigration.up(db);

  const rows = db
    .query('SELECT archive_path AS p, project, project_name AS pn FROM memory_records ORDER BY id')
    .all() as Array<{ p: string; project: string; pn: string }>;

  expect(rows[0]).toMatchObject({ project: 'widget', pn: 'widget' });
  expect(rows[1]).toMatchObject({ project: 'widget', pn: 'widget' });
  expect(rows[2]).toMatchObject({ project: 'gadget', pn: 'gadget' });

  // idempotent: re-run does not change values and does not throw
  projectColumnsMigration.up(db);
  const again = db
    .query('SELECT project FROM memory_records ORDER BY id')
    .all() as Array<{ project: string }>;
  expect(again.map((r) => r.project)).toEqual(['widget', 'widget', 'gadget']);

  db.close();
});
