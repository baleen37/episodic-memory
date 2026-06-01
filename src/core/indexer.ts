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

function deleteMemoryIndexForSpan(db: Database, span: TranscriptSpan): void {
  const rows = db.query(`
    SELECT id FROM memory_records
    WHERE archive_path = ? AND line_start = ? AND line_end = ?
  `).all(span.archivePath, span.lineStart, span.lineEnd) as Array<{ id: number }>;
  const ids = rows.map(row => row.id);

  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    db.query(`DELETE FROM vec_memory_records WHERE rowid IN (${placeholders})`).run(...ids);
  }

  db.query(`
    DELETE FROM memory_records
    WHERE archive_path = ? AND line_start = ? AND line_end = ?
  `).run(span.archivePath, span.lineStart, span.lineEnd);
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

      deleteMemoryIndexForSpan(db, span);

      if (records.length === 0) {
        upsertExtractionState(db, {
          sourceKind: span.sourceKind,
          archivePath: span.archivePath,
          lineStart: span.lineStart,
          lineEnd: span.lineEnd,
          sourceHash,
          extractionVersion: CURRENT_EXTRACTION_VERSION,
          status: 'empty',
        });
        result.spansEmpty++;
        continue;
      }

      for (const record of records) {
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

        const embedding = await embedPassage(record.text);
        if (embedding) {
          insertMemoryRecordVector(db, memoryRecordId, embedding);
        }
        result.memoryRecordsIndexed++;
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
