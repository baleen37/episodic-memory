import { Database } from 'bun:sqlite';

export interface MemoryStats {
  totalMemoryRecords: number;
  activeMemoryRecords: number;
  supersededMemoryRecords: number;
  factCount: number;
  eventCount: number;
  vectorizedRecords: number;
  missingVectors: number;
  extractionDoneSpans: number;
  extractionEmptySpans: number;
  extractionErroredSpans: number;
  dateRange?: { earliest: number; latest: number };
  sourceKinds: Array<{ sourceKind: string; count: number }>;
  topProjects: Array<{ project: string; count: number }>;
}

function count(db: Database, sql: string): number {
  const row = db.query(sql).get() as { count: number };
  return row.count;
}

export function getMemoryStats(db: Database): MemoryStats {
  const dateRange = db.query(`
    SELECT MIN(observed_at) AS earliest, MAX(observed_at) AS latest
    FROM memory_records
    WHERE observed_at IS NOT NULL
  `).get() as { earliest: number | null; latest: number | null };

  const sourceKinds = db.query(`
    SELECT source_kind AS sourceKind, COUNT(*) AS count
    FROM memory_records
    GROUP BY source_kind
    ORDER BY count DESC, source_kind ASC
  `).all() as Array<{ sourceKind: string; count: number }>;

  const topProjects = db.query(`
    SELECT project, COUNT(*) AS count
    FROM memory_records
    WHERE project IS NOT NULL AND project != ''
    GROUP BY project
    ORDER BY count DESC, project ASC
    LIMIT 10
  `).all() as Array<{ project: string; count: number }>;

  return {
    totalMemoryRecords: count(db, 'SELECT COUNT(*) AS count FROM memory_records'),
    activeMemoryRecords: count(db, "SELECT COUNT(*) AS count FROM memory_records WHERE status = 'active'"),
    supersededMemoryRecords: count(db, "SELECT COUNT(*) AS count FROM memory_records WHERE status = 'superseded'"),
    factCount: count(db, "SELECT COUNT(*) AS count FROM memory_records WHERE kind = 'fact'"),
    eventCount: count(db, "SELECT COUNT(*) AS count FROM memory_records WHERE kind = 'event'"),
    vectorizedRecords: count(db, 'SELECT COUNT(*) AS count FROM vec_memory_records'),
    missingVectors: count(db, `
      SELECT COUNT(*) AS count
      FROM memory_records m
      LEFT JOIN vec_memory_records v ON v.rowid = m.id
      WHERE m.status = 'active' AND v.rowid IS NULL
    `),
    extractionDoneSpans: count(db, "SELECT COUNT(*) AS count FROM extraction_state WHERE status = 'done'"),
    extractionEmptySpans: count(db, "SELECT COUNT(*) AS count FROM extraction_state WHERE status = 'empty'"),
    extractionErroredSpans: count(db, "SELECT COUNT(*) AS count FROM extraction_state WHERE status = 'errored'"),
    ...(dateRange.earliest !== null && dateRange.latest !== null
      ? { dateRange: { earliest: dateRange.earliest, latest: dateRange.latest } }
      : {}),
    sourceKinds,
    topProjects,
  };
}
