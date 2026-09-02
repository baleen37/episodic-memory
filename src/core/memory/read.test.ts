import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createMemorySchema } from './schema.js';
import { insertMemories } from './store.js';
import { readMemories } from './read.js';

function vector(): number[] {
  return [1, ...Array<number>(383).fill(0)];
}

describe('readMemories', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    sqliteVec.load(db);
    createMemorySchema(db);
    insertMemories(db, [
      { id: 'm1', memory: 'first memory', metadata: { user_id: 'local' }, embedding: vector() },
      { id: 'm2', memory: 'second memory', metadata: { user_id: 'local' }, embedding: vector() },
    ]);
  });

  afterEach(() => db.close());

  test('reads requested records in requested order and reports missing ids', () => {
    const result = readMemories(db, ['m2', 'missing', 'm1']);

    expect(result.results.map((row) => row.id)).toEqual(['m2', 'm1']);
    expect(result.results[0].metadata).toEqual({ user_id: 'local' });
    expect(result.missing).toEqual(['missing']);
  });

  test('returns an empty result for no ids without querying the corpus', () => {
    expect(readMemories(db, [])).toEqual({ results: [], missing: [] });
  });
});
