import { Database } from 'bun:sqlite';

export interface VerificationResult {
  totalMemories: number;
  missingVectors: Array<{ id: string }>;
  orphanVectors: Array<{ rowid: number }>;
}

export function verifyMemoryIndex(db: Database): VerificationResult {
  const totalMemories = (db.query('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;

  const missingVectors = db.query(`
    SELECT m.id AS id
    FROM memories m
    LEFT JOIN vec_memories v ON v.rowid = m.rowid
    WHERE v.rowid IS NULL
    ORDER BY m.rowid ASC
  `).all() as VerificationResult['missingVectors'];

  const orphanVectors = db.query(`
    SELECT v.rowid AS rowid
    FROM vec_memories v
    LEFT JOIN memories m ON m.rowid = v.rowid
    WHERE m.rowid IS NULL
    ORDER BY v.rowid ASC
  `).all() as VerificationResult['orphanVectors'];

  return {
    totalMemories,
    missingVectors,
    orphanVectors,
  };
}
