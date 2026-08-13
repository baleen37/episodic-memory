import { log } from './logger.js';
import type { LLMProvider } from './llm/types.js';
import type { SourceAdapter, TranscriptSpan } from './sources/types.js';

export interface IndexableArchiveFile {
  adapter: SourceAdapter;
  archivePath: string;
  mtimeMs: number;
}

export interface IndexPendingArchivesArgs {
  files: readonly IndexableArchiveFile[];
  provider: LLMProvider | null;
  extractionBudget: number;
  readArchiveFile: (archivePath: string) => string | null;
  markIndexed: (archivePath: string, mtimeMs: number) => void;
  indexSpan: (file: IndexableArchiveFile, span: TranscriptSpan, provider: LLMProvider) => Promise<number>;
}

export interface IndexPendingArchivesResult {
  filesIndexed: number;
  memoriesAdded: number;
  skipped: number;
  failed: number;
}

/**
 * Applies the per-run archive indexing policy.
 *
 * A file is marked complete only after every parsed span succeeds. The caller
 * owns archive I/O and memory ingestion; this module owns budget and retry
 * semantics.
 */
export async function indexPendingArchives(
  args: IndexPendingArchivesArgs,
): Promise<IndexPendingArchivesResult> {
  const { files, provider, extractionBudget, readArchiveFile, markIndexed, indexSpan } = args;
  const result: IndexPendingArchivesResult = {
    filesIndexed: 0,
    memoriesAdded: 0,
    skipped: 0,
    failed: 0,
  };

  const total = files.length;
  if (total > 0) {
    log.info(`Indexing ${total} archive file${total === 1 ? '' : 's'}...`);
  }

  let remainingBudget = extractionBudget;
  const progressInterval = Math.max(1, Math.floor(total / 20));

  for (const file of files) {
    if (provider && remainingBudget <= 0) {
      log.info('Extraction budget exhausted; deferring remaining files to next sync', {
        remaining: total - result.filesIndexed,
      });
      break;
    }

    const content = readArchiveFile(file.archivePath);
    if (content === null) {
      result.skipped++;
      continue;
    }

    const spans = file.adapter.parse(content, {
      archivePath: file.archivePath,
      sourceKind: file.adapter.kind,
    });

    if (!provider) {
      result.filesIndexed++;
      logProgress(result.filesIndexed, total, progressInterval);
      continue;
    }

    let hadFailure = false;
    for (const span of spans) {
      remainingBudget--;

      try {
        result.memoriesAdded += await indexSpan(file, span, provider);
      } catch (error) {
        hadFailure = true;
        result.failed++;
        log.warn('Span extraction failed; continuing sync.', {
          archivePath: file.archivePath,
          lineStart: span.lineStart,
          lineEnd: span.lineEnd,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!hadFailure) {
      markIndexed(file.archivePath, file.mtimeMs);
      result.filesIndexed++;
    }
    logProgress(result.filesIndexed, total, progressInterval);
  }

  return result;
}

function logProgress(indexed: number, total: number, interval: number): void {
  if (indexed % interval === 0 || indexed === total) {
    log.info(`  ${indexed}/${total} indexed`);
  }
}
