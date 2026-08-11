import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildFilterSql, assertScoped } from './filters.js';

function run(filters: Parameters<typeof buildFilterSql>[0], rows: Array<Record<string, unknown>>): string[] {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, metadata TEXT)');
  for (const [i, meta] of rows.entries()) {
    db.query('INSERT INTO memories (id, metadata) VALUES (?, ?)').run(`id-${i}`, JSON.stringify(meta));
  }
  const { clause, params } = buildFilterSql(filters);
  const sql = `SELECT id FROM memories${clause ? ` WHERE ${clause}` : ''} ORDER BY id`;
  return (db.query(sql).all(...(params as never[])) as Array<{ id: string }>).map(r => r.id);
}

describe('assertScoped', () => {
  test('accepts any one scoping key', () => {
    expect(() => assertScoped({ user_id: 'u1' })).not.toThrow();
    expect(() => assertScoped({ agent_id: 'a1' })).not.toThrow();
    expect(() => assertScoped({ run_id: 'r1' })).not.toThrow();
  });
  test('rejects filters with no scoping key', () => {
    expect(() => assertScoped({ role: 'user' })).toThrow(/user_id.*agent_id.*run_id/);
  });
});

describe('buildFilterSql', () => {
  const rows = [
    { user_id: 'u1', role: 'user', n: 5, tag: 'Alpha Beta' },
    { user_id: 'u1', role: 'assistant', n: 10, tag: 'gamma' },
    { user_id: 'u2', role: 'user', n: 15, tag: 'delta' },
  ];

  test('bare value is equality', () => {
    expect(run({ user_id: 'u1' }, rows)).toEqual(['id-0', 'id-1']);
  });
  test('eq / ne', () => {
    expect(run({ role: { eq: 'user' } }, rows)).toEqual(['id-0', 'id-2']);
    expect(run({ role: { ne: 'user' } }, rows)).toEqual(['id-1']);
  });
  test('in / nin', () => {
    expect(run({ role: { in: ['user'] } }, rows)).toEqual(['id-0', 'id-2']);
    expect(run({ role: { nin: ['user'] } }, rows)).toEqual(['id-1']);
  });
  test('gt / gte / lt / lte', () => {
    expect(run({ n: { gt: 10 } }, rows)).toEqual(['id-2']);
    expect(run({ n: { gte: 10 } }, rows)).toEqual(['id-1', 'id-2']);
    expect(run({ n: { lt: 10 } }, rows)).toEqual(['id-0']);
    expect(run({ n: { lte: 10 } }, rows)).toEqual(['id-0', 'id-1']);
  });
  test('contains is case-sensitive, icontains is not', () => {
    expect(run({ tag: { contains: 'Alpha' } }, rows)).toEqual(['id-0']);
    expect(run({ tag: { contains: 'alpha' } }, rows)).toEqual([]);
    expect(run({ tag: { icontains: 'alpha' } }, rows)).toEqual(['id-0']);
  });
  test('wildcard * matches any value for the key', () => {
    expect(run({ user_id: '*' }, rows)).toEqual(['id-0', 'id-1', 'id-2']);
  });
  test('array shorthand behaves as in', () => {
    expect(run({ user_id: ['u1', 'u2'] }, rows)).toEqual(['id-0', 'id-1', 'id-2']);
  });
  test('top-level keys AND together', () => {
    expect(run({ user_id: 'u1', role: 'user' }, rows)).toEqual(['id-0']);
  });
  test('OR / AND / NOT', () => {
    expect(run({ OR: [{ user_id: 'u2' }, { role: 'assistant' }] }, rows)).toEqual(['id-1', 'id-2']);
    expect(run({ AND: [{ user_id: 'u1' }, { n: { gte: 10 } }] }, rows)).toEqual(['id-1']);
    expect(run({ NOT: { user_id: 'u1' } }, rows)).toEqual(['id-2']);
  });
  test('empty filters produce no clause', () => {
    expect(buildFilterSql({}).clause).toBe('');
  });
  test('values are parameterized, not interpolated', () => {
    const { clause, params } = buildFilterSql({ user_id: "'; DROP TABLE memories; --" });
    expect(clause).not.toContain('DROP');
    expect(params).toContain("'; DROP TABLE memories; --");
  });
});
