import type { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import {
  getArchiveIndexMtime,
  openDatabase,
  setArchiveIndexMtime,
} from '../core/db.js';
import { createMemorySchema } from '../core/memory/schema.js';
import { addMemories } from '../core/memory/add.js';
import { deleteMemoriesByRunIds } from '../core/memory/store.js';
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

/** Fixed local identifier used as the mem0 user_id scope for all archives synced by this machine. */
export const LOCAL_USER_ID = 'local';

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

  const total = pendingFiles.length;
  if (total > 0) {
    log.info(`Indexing ${total} archive file${total === 1 ? '' : 's'}...`);
  }

  // Bound the LLM work per sync so the lock is never held for hours. Remaining
  // files are picked up by the next sync.
  let extractionBudget = EXTRACTION_BUDGET_PER_SYNC;
  let indexed = 0;
  const progressInterval = Math.max(1, Math.floor(total / 20));
  for (const file of pendingFiles) {
    if (provider && extractionBudget <= 0) {
      log.info(`Extraction budget exhausted; deferring remaining files to next sync`, {
        remaining: total - indexed,
      });
      break;
    }

    const content = readArchiveFile(file.archivePath);
    if (content === null) {
      stats.skipped++;
      continue;
    }

    const spans = file.adapter.parse(content, { archivePath: file.archivePath, sourceKind: file.adapter.kind });

    if (!provider) {
      // No provider configured: archives are copied but extraction is skipped entirely.
      indexed++;
      if (indexed % progressInterval === 0 || indexed === total) {
        log.info(`  ${indexed}/${total} indexed`);
      }
      continue;
    }

    const filters = mapSourceToFilters({ sourceKind: file.adapter.kind, archivePath: file.archivePath });

    let deferred = false;
    let hadFailure = false;
    for (const span of spans) {
      if (extractionBudget <= 0) {
        deferred = true;
        break;
      }
      extractionBudget--;

      try {
        const result = await addMemories({
          db,
          provider,
          messages: span.messages,
          filters,
          sessionKey: filters.run_id ?? file.archivePath,
          observationDate: span.observedAt ? new Date(span.observedAt).toISOString().slice(0, 10) : undefined,
        });
        stats.memoriesAdded += result.results.length;
      } catch (error) {
        hadFailure = true;
        stats.failed++;
        log.warn('Span extraction failed; continuing sync.', {
          archivePath: file.archivePath,
          lineStart: span.lineStart,
          lineEnd: span.lineEnd,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Only mark the file fully indexed when every span was processed without
    // error. If the budget ran out partway through, or any span's extraction
    // failed, leave the mtime marker unset so the next sync reconsiders this
    // file (and re-runs already-processed spans through addMemories, whose
    // md5 dedup makes that safe).
    if (!deferred && !hadFailure) {
      setArchiveIndexMtime(db, file.archivePath, file.mtimeMs);
      indexed++;
    }
    if (indexed % progressInterval === 0 || indexed === total) {
      log.info(`  ${indexed}/${total} indexed`);
    }

    if (deferred) {
      log.info(`Extraction budget exhausted; deferring remaining files to next sync`, {
        processed: indexed,
        remaining: total - indexed,
      });
      break;
    }
  }

  stats.filesIndexed = indexed;
  return stats;
}

export async function runSyncCli(): Promise<void> {
  const release = acquireSyncLock();
  if (!release) {
    log.info('sync already running; skipping');
    return;
  }
  const db = openDatabase();
  // Transitional: the mem0 memory tables (`memories`, `vec_memories`, etc.) live in a
  // separate schema from the legacy `memory_records`/`extraction_state` tables that
  // `openDatabase()` creates. Both currently coexist on this one connection because
  // `archive_index_state` (and the migrations that touch it) still live in db.ts's old
  // schema. Task 11 deletes the old schema and its migrations wholesale, at which point
  // sync moves onto `openMemoryDb()` alone.
  createMemorySchema(db);
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
