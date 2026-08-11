import { Database } from 'bun:sqlite';

export interface MemoryStats {
  totalMemories: number;
  vectorizedMemories: number;
  missingVectors: number;
}

function count(db: Database, sql: string): number {
  const row = db.query(sql).get() as { count: number };
  return row.count;
}

export function getMemoryStats(db: Database): MemoryStats {
  return {
    totalMemories: count(db, 'SELECT COUNT(*) AS count FROM memories'),
    vectorizedMemories: count(db, 'SELECT COUNT(*) AS count FROM vec_memories'),
    missingVectors: count(db, `
      SELECT COUNT(*) AS count
      FROM memories m
      LEFT JOIN vec_memories v ON v.rowid = m.rowid
      WHERE v.rowid IS NULL
    `),
  };
}
