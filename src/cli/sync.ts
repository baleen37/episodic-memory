import type { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import {
  getArchiveIndexMtime,
  openMemoryDb,
  setArchiveIndexMtime,
} from '../core/memory/schema.js';
import { addMemories } from '../core/memory/add.js';
import { deleteMemoriesByRunIds } from '../core/memory/store.js';
import { LOCAL_USER_ID } from '../core/constants.js';
import { indexPendingArchives } from '../core/sync-run.js';
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
 * Sized against LLM latency alone. Embedding used to dominate this budget (a
 * 0.5rps rate limiter cost ~2s per extracted fact); it is now a concurrency-
 * capped batch call measured at 65ms for 10 facts, so it no longer factors in.
 *
 * Measured LLM latency over a real sync run: mean 53s per span, max 85s. At that
 * rate 12 spans is ~10 minutes, which is the lock-hold ceiling the previous
 * value of 20 was also aiming for (it just mis-estimated the per-span cost at
 * 25s). Raising this further does not help throughput — it only holds the lock
 * longer and makes concurrent syncs skip. The real cap on catching up with a
 * backlog is provider latency, not this number.
 */
export const EXTRACTION_BUDGET_PER_SYNC = 12;

export interface SyncStats {
  filesScanned: number;
  filesIndexed: number;
  memoriesAdded: number;
  skipped: number;
  failed: number;
}

interface ArchiveFile {
  adapter: SourceAdapter;
  archivePath: string;
}

export interface SyncOptions {
  /** Inject an extraction provider (tests). Omit to load from config. */
  provider?: LLMProvider | null;
}

/** Maps archived transcript source metadata onto mem0 scoping keys (user_id/agent_id/run_id). */
export function mapSourceToFilters(source: { sourceKind: string; archivePath: string }): Record<string, string> {
  return {
    user_id: LOCAL_USER_ID,
    agent_id: source.sourceKind,
    run_id: path.basename(source.archivePath, path.extname(source.archivePath)),
  };
}

export async function syncArchives(db: Database, options: SyncOptions = {}): Promise<SyncStats> {
  const archiveDir = getArchiveDir();
  const archiveFiles = new Map<string, ArchiveFile>();
  const provider = options.provider !== undefined ? options.provider : await loadExtractionProvider();
  const stats: SyncStats = {
    filesScanned: 0,
    filesIndexed: 0,
    memoriesAdded: 0,
    skipped: 0,
    failed: 0,
  };

  for (const adapter of getBuiltInSourceAdapters()) {
    for (const root of adapter.roots()) {
      const excludedSourceDirs: string[] = [];
      for (const sourcePath of findJsonlFiles(root, adapter, excludedSourceDirs)) {
        const archivePath = path.join(archiveDir, adapter.kind, path.relative(root, sourcePath));
        try {
          copyIfNewer(sourcePath, archivePath);
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

  stats.filesScanned = archiveFiles.size;

  // Skip files we already fully indexed at their current content mtime. This is
  // what keeps a sync bounded: only changed or not-yet-complete files are parsed.
  const pendingFiles: Array<ArchiveFile & { mtimeMs: number }> = [];
  for (const file of archiveFiles.values()) {
    const mtimeMs = statSync(file.archivePath).mtimeMs;
    if (getArchiveIndexMtime(db, file.archivePath) === mtimeMs) {
      stats.skipped++;
      continue;
    }
    pendingFiles.push({ ...file, mtimeMs });
  }

  // Reindexing is incremental, newest archive first.
  pendingFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const indexingResult = await indexPendingArchives({
    files: pendingFiles,
    provider,
    extractionBudget: EXTRACTION_BUDGET_PER_SYNC,
    readArchiveFile,
    markIndexed: (archivePath, mtimeMs) => setArchiveIndexMtime(db, archivePath, mtimeMs),
    indexSpan: async (file, span, activeProvider) => {
      const filters = mapSourceToFilters({ sourceKind: file.adapter.kind, archivePath: file.archivePath });
      const result = await addMemories({
        db,
        provider: activeProvider,
        messages: span.messages,
        filters,
        observationDate: span.observedAt ? new Date(span.observedAt).toISOString().slice(0, 10) : undefined,
      });
      return result.results.length;
    },
  });

  stats.filesIndexed = indexingResult.filesIndexed;
  stats.memoriesAdded += indexingResult.memoriesAdded;
  stats.skipped += indexingResult.skipped;
  stats.failed += indexingResult.failed;
  return stats;
}

export async function runSyncCli(): Promise<void> {
  const release = acquireSyncLock();
  if (!release) {
    log.info('sync already running; skipping');
    return;
  }
  const db = openMemoryDb();
  try {
    const result = await syncArchives(db);
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

function readArchiveFile(archivePath: string): string | null {
  try {
    return readFileSync(archivePath, 'utf-8');
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
  for (const archivePath of archiveFiles.keys()) {
    if (isPathAtOrUnder(archivePath, archivePathPrefix)) {
      archiveFiles.delete(archivePath);
    }
  }

  // The run_id for an archive file is its basename without extension (see
  // mapSourceToFilters). Resolve run_ids from disk before removing the files, then
  // delete every memory extracted from them so a .no-memmem opt-out actually makes
  // those memories unsearchable, not just the archive copy invisible.
  const runIds = collectJsonlRunIds(archivePathPrefix);
  if (runIds.length > 0) {
    deleteMemoriesByRunIds(db, runIds);
  }

  if (existsSync(archivePathPrefix)) {
    rmSync(archivePathPrefix, { recursive: true, force: true });
  }
}

function collectJsonlRunIds(archivePathPrefix: string): string[] {
  if (!existsSync(archivePathPrefix)) return [];

  const stat = statSync(archivePathPrefix);
  if (stat.isFile()) {
    return archivePathPrefix.endsWith('.jsonl')
      ? [path.basename(archivePathPrefix, path.extname(archivePathPrefix))]
      : [];
  }

  const runIds: string[] = [];
  for (const entry of readdirSync(archivePathPrefix, { withFileTypes: true })) {
    const entryPath = path.join(archivePathPrefix, entry.name);
    if (entry.isDirectory()) {
      runIds.push(...collectJsonlRunIds(entryPath));
    } else if (entry.isFile() && entryPath.endsWith('.jsonl')) {
      runIds.push(path.basename(entryPath, path.extname(entryPath)));
    }
  }
  return runIds;
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
