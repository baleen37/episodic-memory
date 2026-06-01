import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import type { Database } from 'bun:sqlite';
import {
  CURRENT_EMBEDDING_VERSION,
  CURRENT_EXTRACTION_VERSION,
  deleteMemoryIndexForArchivePath,
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
    SELECT retry_after AS retryAfter FROM extraction_state
    WHERE archive_path = ? AND line_start = ? AND line_end = ?
      AND source_hash = ? AND extraction_version = ? AND status = 'errored'
      AND retry_after IS NOT NULL AND retry_after > ?
  `).get(archivePath, lineStart, lineEnd, sourceHash, extractionVersion, Date.now()) as { retryAfter: number } | null;
  return row !== null;
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
      upsertExtractionState(db, {
        sourceKind: span.sourceKind,
        archivePath: span.archivePath,
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
        sourceHash,
        extractionVersion: CURRENT_EXTRACTION_VERSION,
        status: 'errored',
        errorMessage: error instanceof Error ? error.message : String(error),
        retryAfter: Date.now() + 60 * 60 * 1000,
      });
      result.spansErrored++;
    }
  }

  return result;
}
