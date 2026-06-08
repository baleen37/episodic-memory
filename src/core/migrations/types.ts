import type { Database } from 'bun:sqlite';

export interface Migration {
  version: number; // sequential, unique, >= 1
  name: string;
  // SQL (DDL), JS backfill, or shell (execSync) — author's choice.
  // Transaction boundaries are the author's responsibility inside up().
  up(db: Database): void;
}
