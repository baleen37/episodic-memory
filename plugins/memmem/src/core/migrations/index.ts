import type { Database } from 'bun:sqlite';
import type { Migration } from './types.js';
import { projectColumnsMigration } from './001-project-columns.js';
import { sourceKindRenameMigration } from './002-source-kind-rename.js';

// Ordered registry. New migrations append with the next version number.
export const MIGRATIONS: Migration[] = [projectColumnsMigration, sourceKindRenameMigration];

function getUserVersion(db: Database): number {
  return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
}

// Testable core: run a given list against a db.
export function runMigrationsWith(db: Database, migrations: Migration[]): void {
  const current = getUserVersion(db);
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => m.version > current);
  for (const m of pending) {
    m.up(db);
    // PRAGMA cannot be parameterized; version is a trusted integer.
    db.exec(`PRAGMA user_version = ${m.version}`);
  }
}

// Production entrypoint: run the real registry.
export function runMigrations(db: Database): void {
  runMigrationsWith(db, MIGRATIONS);
}
