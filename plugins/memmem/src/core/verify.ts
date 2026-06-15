import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'fs';

export interface VerificationResult {
  missingArchives: Array<{ id: number; archivePath: string }>;
  invalidProvenance: Array<{ id: number; archivePath: string; lineStart: number; lineEnd: number }>;
  missingVectors: Array<{ id: number; archivePath: string }>;
  orphanVectors: Array<{ rowid: number }>;
  retryableExtractionErrors: Array<{ id: number; archivePath: string; lineStart: number; lineEnd: number }>;
}

interface ActiveMemoryRecord {
  id: number;
  archivePath: string;
  lineStart: number;
  lineEnd: number;
}

function countLines(filePath: string): number {
  const text = readFileSync(filePath, 'utf8');
  if (text.length === 0) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

export function verifyMemoryIndex(db: Database): VerificationResult {
  const missingArchives: VerificationResult['missingArchives'] = [];
  const invalidProvenance: VerificationResult['invalidProvenance'] = [];

  const activeRecords = db.query(`
    SELECT id, archive_path AS archivePath, line_start AS lineStart, line_end AS lineEnd
    FROM memory_records
    WHERE status = 'active'
    ORDER BY id ASC
  `).all() as ActiveMemoryRecord[];

  const lineCounts = new Map<string, number>();
  for (const record of activeRecords) {
    if (!existsSync(record.archivePath)) {
      missingArchives.push({ id: record.id, archivePath: record.archivePath });
      continue;
    }

    let lineCount = lineCounts.get(record.archivePath);
    if (lineCount === undefined) {
      lineCount = countLines(record.archivePath);
      lineCounts.set(record.archivePath, lineCount);
    }

    if (record.lineStart < 1 || record.lineEnd < record.lineStart || record.lineEnd > lineCount) {
      invalidProvenance.push({
        id: record.id,
        archivePath: record.archivePath,
        lineStart: record.lineStart,
        lineEnd: record.lineEnd,
      });
    }
  }

  const missingVectors = db.query(`
    SELECT m.id, m.archive_path AS archivePath
    FROM memory_records m
    LEFT JOIN vec_memory_records v ON v.rowid = m.id
    WHERE m.status = 'active' AND v.rowid IS NULL
    ORDER BY m.id ASC
  `).all() as VerificationResult['missingVectors'];

  const orphanVectors = db.query(`
    SELECT v.rowid
    FROM vec_memory_records v
    LEFT JOIN memory_records m ON m.id = v.rowid
    WHERE m.id IS NULL
    ORDER BY v.rowid ASC
  `).all() as VerificationResult['orphanVectors'];

  const retryableExtractionErrors = db.query(`
    SELECT id, archive_path AS archivePath, line_start AS lineStart, line_end AS lineEnd
    FROM extraction_state
    WHERE status = 'errored' AND retry_after <= ?
    ORDER BY id ASC
  `).all(Date.now()) as VerificationResult['retryableExtractionErrors'];

  return {
    missingArchives,
    invalidProvenance,
    missingVectors,
    orphanVectors,
    retryableExtractionErrors,
  };
}
