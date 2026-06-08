import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import type { Database } from 'bun:sqlite';
import {
  CURRENT_EMBEDDING_VERSION,
  CURRENT_EXTRACTION_VERSION,
  deleteMemoryIndexForArchivePath,
  getExtractionAttemptCount,
  hasCompletedExtractionState,
  insertMemoryRecord,
  insertMemoryRecordVector,
  upsertExtractionState,
} from './db.js';
import { embedPassage } from './embeddings.js';
import { extractMemoryRecordsFromSpan } from './llm/extractor.js';
import type { LLMProvider } from './llm/types.js';
import type { ExtractedMemoryRecord } from './llm/extractor.js';
import type { ParseContext, TranscriptSpan } from './sources/types.js';

export type ArchiveParser = (content: string, context: ParseContext) => TranscriptSpan[];

export interface ReindexArchiveResult {
  spansConsidered: number;
  spansSkipped: number;
  spansEmpty: number;
  spansErrored: number;
  memoryRecordsIndexed: number;
}

export const EXCLUSION_MARKERS = [
  'DO NOT INDEX THIS CHAT',
  'DO NOT INDEX THIS CONVERSATION',
  '이 대화는 인덱싱하지 마세요',
  '이 대화는 검색에서 제외하세요',
];

export function hasExclusionMarker(content: string): boolean {
  return EXCLUSION_MARKERS.some(marker => content.includes(marker));
}

export const BASE_DELAY_MS = 5 * 60 * 1000; // 5분
export const ATTEMPT_CAP = 10;

/**
 * 지수 백오프 다음 재시도 시각. attemptCount는 이번 실패까지 포함한 누적 횟수.
 * attemptCount >= ATTEMPT_CAP 이면 포기 의미로 null 반환(retry_after=NULL).
 * 즉 10번째 실패(attemptCount=10)에서 null → 최대 9회 재시도 후 포기.
 */
export function computeRetryAfter(attemptCount: number, now: number): number | null {
  if (attemptCount >= ATTEMPT_CAP) {
    return null;
  }
  const delay = BASE_DELAY_MS * 2 ** (attemptCount - 1);
  return now + delay;
}

function emptyResult(): ReindexArchiveResult {
  return {
    spansConsidered: 0,
    spansSkipped: 0,
    spansEmpty: 0,
    spansErrored: 0,
    memoryRecordsIndexed: 0,
  };
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function makeDedupeKey(kind: string, text: string): string {
  const normalized = `${kind}:${text.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  return hashText(normalized);
}

function deleteMemoryRecordsByIds(db: Database, ids: number[]): void {
  if (ids.length === 0) {
    return;
  }

  const placeholders = ids.map(() => '?').join(',');
  db.query(`DELETE FROM vec_memory_records WHERE rowid IN (${placeholders})`).run(...ids);
  db.query(`DELETE FROM memory_records WHERE id IN (${placeholders})`).run(...ids);
}

function deleteMemoryIndexForSpan(db: Database, span: TranscriptSpan): void {
  const rows = db.query(`
    SELECT id FROM memory_records
    WHERE archive_path = ? AND line_start = ? AND line_end = ?
  `).all(span.archivePath, span.lineStart, span.lineEnd) as Array<{ id: number }>;
  deleteMemoryRecordsByIds(db, rows.map(row => row.id));
}

function deleteExtractionStateForSpan(db: Database, archivePath: string, lineStart: number, lineEnd: number): void {
  db.query(`
    DELETE FROM extraction_state
    WHERE archive_path = ? AND line_start = ? AND line_end = ?
  `).run(archivePath, lineStart, lineEnd);
}

function pruneStaleMemoryIndexForArchivePath(db: Database, archivePath: string, spans: TranscriptSpan[]): void {
  const currentSpanKeys = new Set(spans.map(span => `${span.lineStart}:${span.lineEnd}`));
  const memoryRows = db.query(`
    SELECT id, line_start AS lineStart, line_end AS lineEnd
    FROM memory_records
    WHERE archive_path = ?
  `).all(archivePath) as Array<{ id: number; lineStart: number; lineEnd: number }>;
  const stateRows = db.query(`
    SELECT line_start AS lineStart, line_end AS lineEnd
    FROM extraction_state
    WHERE archive_path = ?
  `).all(archivePath) as Array<{ lineStart: number; lineEnd: number }>;
  const staleMemoryRows = memoryRows.filter(row => !currentSpanKeys.has(`${row.lineStart}:${row.lineEnd}`));
  const staleStateKeys = new Set(
    stateRows
      .filter(row => !currentSpanKeys.has(`${row.lineStart}:${row.lineEnd}`))
      .map(row => `${row.lineStart}:${row.lineEnd}`),
  );

  deleteMemoryRecordsByIds(db, staleMemoryRows.map(row => row.id));
  for (const key of staleStateKeys) {
    const [lineStart, lineEnd] = key.split(':').map(Number);
    deleteExtractionStateForSpan(db, archivePath, lineStart, lineEnd);
  }
}

function hasPendingRetryExtractionState(
  db: Database,
  archivePath: string,
  lineStart: number,
  lineEnd: number,
  sourceHash: string,
  extractionVersion: number,
): boolean {
  const row = db.query(`
    SELECT 1 AS one FROM extraction_state
    WHERE archive_path = ? AND line_start = ? AND line_end = ?
      AND source_hash = ? AND extraction_version = ? AND status = 'errored'
      AND (
        (retry_after IS NOT NULL AND retry_after > ?)
        OR (attempt_count >= ? AND retry_after IS NULL)
      )
  `).get(
    archivePath, lineStart, lineEnd, sourceHash, extractionVersion,
    Date.now(), ATTEMPT_CAP,
  ) as { one: number } | null;
  return row !== null;
}

// Test-only export
export function hasPendingRetryExtractionStateForTests(
  db: Database,
  archivePath: string,
  lineStart: number,
  lineEnd: number,
  sourceHash: string,
  extractionVersion: number,
): boolean {
  return hasPendingRetryExtractionState(
    db, archivePath, lineStart, lineEnd, sourceHash, extractionVersion,
  );
}

interface PreparedMemoryRecord {
  record: ExtractedMemoryRecord;
  embedding: number[];
}

export async function reindexArchiveFile(
  db: Database,
  archivePath: string,
  sourceKind: string,
  parser: ArchiveParser,
  provider: LLMProvider | null,
): Promise<ReindexArchiveResult> {
  const content = readFileSync(archivePath, 'utf-8');
  if (hasExclusionMarker(content)) {
    deleteMemoryIndexForArchivePath(db, archivePath);
    return emptyResult();
  }

  const spans = parser(content, { archivePath, sourceKind });
  const result: ReindexArchiveResult = {
    spansConsidered: spans.length,
    spansSkipped: 0,
    spansEmpty: 0,
    spansErrored: 0,
    memoryRecordsIndexed: 0,
  };

  pruneStaleMemoryIndexForArchivePath(db, archivePath, spans);

  if (!provider) {
    result.spansSkipped = spans.length;
    return result;
  }

  for (const span of spans) {
    const sourceHash = hashText(span.text);

    if (hasCompletedExtractionState(
      db,
      span.archivePath,
      span.lineStart,
      span.lineEnd,
      sourceHash,
      CURRENT_EXTRACTION_VERSION,
    )) {
      result.spansSkipped++;
      continue;
    }

    if (hasPendingRetryExtractionState(
      db,
      span.archivePath,
      span.lineStart,
      span.lineEnd,
      sourceHash,
      CURRENT_EXTRACTION_VERSION,
    )) {
      result.spansSkipped++;
      continue;
    }

    try {
      const records = await extractMemoryRecordsFromSpan(provider, {
        sourceKind: span.sourceKind,
        archivePath: span.archivePath,
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
        observedAt: span.observedAt,
        project: span.project,
        text: span.text,
      }, { maxRecords: 10 });

      const preparedRecords: PreparedMemoryRecord[] = [];
      for (const record of records) {
        const embedding = await embedPassage(record.text);
        if (!embedding) {
          throw new Error('embedding failed');
        }
        preparedRecords.push({ record, embedding });
      }

      const replaceSpanIndex = db.transaction(() => {
        deleteMemoryIndexForSpan(db, span);

        if (preparedRecords.length === 0) {
          upsertExtractionState(db, {
            sourceKind: span.sourceKind,
            archivePath: span.archivePath,
            lineStart: span.lineStart,
            lineEnd: span.lineEnd,
            sourceHash,
            extractionVersion: CURRENT_EXTRACTION_VERSION,
            status: 'empty',
            attemptCount: 0,
          });
          return 0;
        }

        for (const { record, embedding } of preparedRecords) {
          const memoryRecordId = insertMemoryRecord(db, {
            kind: record.kind,
            text: record.text,
            sourceKind: span.sourceKind,
            archivePath: span.archivePath,
            lineStart: span.lineStart,
            lineEnd: span.lineEnd,
            observedAt: span.observedAt,
            project: span.project,
            projectName: null,
            confidence: record.confidence,
            dedupeKey: record.dedupeKey ?? makeDedupeKey(record.kind, record.text),
            extractionVersion: CURRENT_EXTRACTION_VERSION,
            embeddingVersion: CURRENT_EMBEDDING_VERSION,
          });
          insertMemoryRecordVector(db, memoryRecordId, embedding);
        }

        upsertExtractionState(db, {
          sourceKind: span.sourceKind,
          archivePath: span.archivePath,
          lineStart: span.lineStart,
          lineEnd: span.lineEnd,
          sourceHash,
          extractionVersion: CURRENT_EXTRACTION_VERSION,
          status: 'done',
          attemptCount: 0,
        });
        return preparedRecords.length;
      });

      const indexedCount = replaceSpanIndex();
      if (indexedCount === 0) {
        result.spansEmpty++;
      } else {
        result.memoryRecordsIndexed += indexedCount;
      }
    } catch (error) {
      const now = Date.now();
      const prevAttempts = getExtractionAttemptCount(
        db,
        span.archivePath,
        span.lineStart,
        span.lineEnd,
        sourceHash,
        CURRENT_EXTRACTION_VERSION,
      );
      const attemptCount = prevAttempts + 1;
      upsertExtractionState(db, {
        sourceKind: span.sourceKind,
        archivePath: span.archivePath,
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
        sourceHash,
        extractionVersion: CURRENT_EXTRACTION_VERSION,
        status: 'errored',
        errorMessage: error instanceof Error ? error.message : String(error),
        attemptCount,
        retryAfter: computeRetryAfter(attemptCount, now),
      });
      result.spansErrored++;
    }
  }

  return result;
}
