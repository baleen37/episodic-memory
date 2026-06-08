import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrationsWith } from './index.js';
import type { Migration } from './types.js';

function userVersion(db: Database): number {
  return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
}

describe('runMigrationsWith', () => {
  test('applies pending migrations in order and advances user_version', () => {
    const db = new Database(':memory:');
    const applied: number[] = [];
    const migs: Migration[] = [
      { version: 1, name: 'a', up: () => applied.push(1) },
      { version: 2, name: 'b', up: () => applied.push(2) },
    ];
    runMigrationsWith(db, migs);
    expect(applied).toEqual([1, 2]);
    expect(userVersion(db)).toBe(2);
    db.close();
  });

  test('skips already-applied migrations (re-run is no-op)', () => {
    const db = new Database(':memory:');
    const applied: number[] = [];
    const migs: Migration[] = [
      { version: 1, name: 'a', up: () => applied.push(1) },
      { version: 2, name: 'b', up: () => applied.push(2) },
    ];
    runMigrationsWith(db, migs);
    runMigrationsWith(db, migs);
    expect(applied).toEqual([1, 2]);
    expect(userVersion(db)).toBe(2);
    db.close();
  });

  test('throwing migration stops progress and leaves user_version at last good', () => {
    const db = new Database(':memory:');
    const migs: Migration[] = [
      { version: 1, name: 'a', up: () => {} },
      { version: 2, name: 'boom', up: () => { throw new Error('boom'); } },
      { version: 3, name: 'c', up: () => {} },
    ];
    expect(() => runMigrationsWith(db, migs)).toThrow('boom');
    expect(userVersion(db)).toBe(1);
    db.close();
  });

  test('applies out-of-order registry entries by ascending version', () => {
    const db = new Database(':memory:');
    const applied: number[] = [];
    const migs: Migration[] = [
      { version: 2, name: 'b', up: () => applied.push(2) },
      { version: 1, name: 'a', up: () => applied.push(1) },
    ];
    runMigrationsWith(db, migs);
    expect(applied).toEqual([1, 2]);
    db.close();
  });
});
