import type { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import {
  clearArchiveIndexMtime,
  deleteMemoryIndexForArchivePathPrefix,
  getArchiveIndexMtime,
  openDatabase,
  setArchiveIndexMtime,
} from '../core/db.js';
import { reindexArchiveFile } from '../core/indexer.js';
import { loadConfig, createProvider } from '../core/llm/index.js';
import type { LLMProvider } from '../core/llm/types.js';
import { log } from '../core/logger.js';
import { acquireSyncLock } from '../core/lock.js';
import { getArchiveDir } from '../core/paths.js';
import { getBuiltInSourceAdapters, type SourceAdapter } from '../core/sources/index.js';

/**
 * Maximum LLM extractions a single sync run may perform. Caps how long the sync
 * lock is held so it always finishes; leftover spans are indexed by later syncs.
 *
 * Sized against measured throughput: extraction runs ~25s/record (LLM latency +
 * rate limiting), so 20 keeps a single sync under ~10 minutes of lock hold.
 */
export const EXTRACTION_BUDGET_PER_SYNC = 20;

export interface SyncResult {
  copied: number;
  archived: number;
  spansConsidered: number;
  spansSkipped: number;
  spansEmpty: number;
  spansErrored: number;
  memoryRecordsIndexed: number;
}

interface ArchiveFile {
  adapter: SourceAdapter;
  archivePath: string;
}

export interface SyncOptions {
  /** Inject an extraction provider (tests). Omit to load from config. */
  provider?: LLMProvider | null;
}

export async function syncTranscripts(db: Database, options: SyncOptions = {}): Promise<SyncResult> {
  const archiveDir = getArchiveDir();
  const archiveFiles = new Map<string, ArchiveFile>();
  const provider = options.provider !== undefined ? options.provider : await loadExtractionProvider();
  const result: SyncResult = {
    copied: 0,
    archived: 0,
    spansConsidered: 0,
    spansSkipped: 0,
    spansEmpty: 0,
    spansErrored: 0,
    memoryRecordsIndexed: 0,
  };

  for (const adapter of getBuiltInSourceAdapters()) {
    for (const root of adapter.roots()) {
      const excludedSourceDirs: string[] = [];
      for (const sourcePath of findJsonlFiles(root, adapter, excludedSourceDirs)) {
        const archivePath = path.join(archiveDir, adapter.kind, path.relative(root, sourcePath));
        try {
          if (copyIfNewer(sourcePath, archivePath)) {
            result.copied++;
          }
        } catch (error) {
          log.warn('Failed to copy transcript; continuing sync.', {
            sourcePath,
            archivePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (existsSync(archivePath)) {
          archiveFiles.set(archivePath, { adapter, archivePath });
        }
      }

      for (const sourceDir of excludedSourceDirs) {
        const archivePathPrefix = path.join(archiveDir, adapter.kind, path.relative(root, sourceDir));
        purgeExcludedArchiveSubtree(db, archivePathPrefix, archiveFiles);
      }
    }

    const adapterArchiveRoot = path.join(archiveDir, adapter.kind);
    if (existsSync(adapterArchiveRoot)) {
      for (const archivePath of findJsonlFiles(adapterArchiveRoot, adapter)) {
        archiveFiles.set(archivePath, { adapter, archivePath });
      }
    }
  }

  // Skip files we already fully indexed at their current content mtime. This is
  // what keeps a sync bounded: only changed or not-yet-complete files are parsed.
  const pendingFiles: Array<ArchiveFile & { mtimeMs: number }> = [];
  for (const file of archiveFiles.values()) {
    const mtimeMs = statSync(file.archivePath).mtimeMs;
    if (getArchiveIndexMtime(db, file.archivePath) === mtimeMs) {
      continue;
    }
    pendingFiles.push({ ...file, mtimeMs });
  }

  const total = pendingFiles.length;
  if (total > 0) {
    log.info(`Indexing ${total} archive file${total === 1 ? '' : 's'}...`);
  }

  // Bound the LLM work per sync so the lock is never held for hours. Remaining
  // spans are picked up by the next sync.
  let extractionBudget = EXTRACTION_BUDGET_PER_SYNC;
  let archived = 0;
  const progressInterval = Math.max(1, Math.floor(total / 20));
  for (const file of pendingFiles) {
    const reindexResult = await reindexArchiveFile(
      db,
      file.archivePath,
      file.adapter.kind,
      file.adapter.parse,
      provider,
      { extractionBudget },
    );
    result.spansConsidered += reindexResult.spansConsidered;
    result.spansSkipped += reindexResult.spansSkipped;
    result.spansEmpty += reindexResult.spansEmpty;
    result.spansErrored += reindexResult.spansErrored;
    result.memoryRecordsIndexed += reindexResult.memoryRecordsIndexed;
    extractionBudget -= reindexResult.extractionsPerformed;

    // Mark the file fully indexed only when extraction actually ran to completion:
    // a provider was present, nothing was deferred by budget, and no span errored.
    // Without a provider, spans are merely skipped (not extracted), so we must NOT
    // mark the file done — otherwise it would never be indexed once a provider is set.
    if (provider && reindexResult.spansDeferred === 0 && reindexResult.spansErrored === 0) {
      setArchiveIndexMtime(db, file.archivePath, file.mtimeMs);
    } else {
      clearArchiveIndexMtime(db, file.archivePath);
    }

    archived++;
    if (archived % progressInterval === 0 || archived === total) {
      log.info(`  ${archived}/${total} indexed`);
    }

    if (extractionBudget <= 0) {
      log.info(`Extraction budget exhausted; deferring remaining files to next sync`, {
        processed: archived,
        remaining: total - archived,
      });
      break;
    }
  }

  result.archived = archived;
  return result;
}

export async function runSyncCli(): Promise<void> {
  const release = acquireSyncLock();
  if (!release) {
    log.info('sync already running; skipping');
    return;
  }
  const db = openDatabase();
  try {
    const result = await syncTranscripts(db);
    log.info(`Done.`, { ...result });
  } finally {
    db.close();
    release();
  }
}

async function loadExtractionProvider(): Promise<LLMProvider | null> {
  try {
    const config = loadConfig();
    return config ? await createProvider(config) : null;
  } catch {
    return null;
  }
}

function findJsonlFiles(root: string, adapter: SourceAdapter, excludedDirs: string[] = []): string[] {
  const files: string[] = [];
  if (existsSync(path.join(root, '.no-memmem'))) {
    excludedDirs.push(root);
    return files;
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonlFiles(entryPath, adapter, excludedDirs));
    } else if (entry.isFile() && entryPath.endsWith('.jsonl') && adapter.detect(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

function purgeExcludedArchiveSubtree(
  db: Database,
  archivePathPrefix: string,
  archiveFiles: Map<string, ArchiveFile>,
): void {
  deleteMemoryIndexForArchivePathPrefix(db, archivePathPrefix);
  for (const archivePath of archiveFiles.keys()) {
    if (isPathAtOrUnder(archivePath, archivePathPrefix)) {
      archiveFiles.delete(archivePath);
    }
  }
  if (existsSync(archivePathPrefix)) {
    rmSync(archivePathPrefix, { recursive: true, force: true });
  }
}

function isPathAtOrUnder(filePath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function copyIfNewer(sourcePath: string, destinationPath: string): boolean {
  const sourceBefore = statSync(sourcePath);
  if (existsSync(destinationPath) && statSync(destinationPath).mtimeMs >= sourceBefore.mtimeMs) {
    return false;
  }

  mkdirSync(path.dirname(destinationPath), { recursive: true });
  const tmpPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  copyFileSync(sourcePath, tmpPath);

  const sourceAfter = statSync(sourcePath);
  if (sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs) {
    unlinkIfExists(tmpPath);
    return false;
  }

  renameSync(tmpPath, destinationPath);
  return true;
}

function unlinkIfExists(filePath: string): void {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}
