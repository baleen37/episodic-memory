import type { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import { deleteMemoryIndexForArchivePathPrefix, openDatabase } from '../core/db.js';
import { reindexArchiveFile } from '../core/indexer.js';
import { loadConfig, createProvider } from '../core/llm/index.js';
import type { LLMProvider } from '../core/llm/types.js';
import { log } from '../core/logger.js';
import { getArchiveDir } from '../core/paths.js';
import { getBuiltInSourceAdapters, type SourceAdapter } from '../core/sources/index.js';

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

export async function syncTranscripts(db: Database): Promise<SyncResult> {
  const archiveDir = getArchiveDir();
  const archiveFiles = new Map<string, ArchiveFile>();
  const provider = await loadExtractionProvider();
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

  const total = archiveFiles.size;
  if (total > 0) {
    log.info(`Indexing ${total} archive file${total === 1 ? '' : 's'}...`);
  }

  let archived = 0;
  const progressInterval = Math.max(1, Math.floor(total / 20));
  for (const file of archiveFiles.values()) {
    const reindexResult = await reindexArchiveFile(db, file.archivePath, file.adapter.kind, file.adapter.parse, provider);
    result.spansConsidered += reindexResult.spansConsidered;
    result.spansSkipped += reindexResult.spansSkipped;
    result.spansEmpty += reindexResult.spansEmpty;
    result.spansErrored += reindexResult.spansErrored;
    result.memoryRecordsIndexed += reindexResult.memoryRecordsIndexed;
    archived++;
    if (archived % progressInterval === 0 || archived === total) {
      log.info(`  ${archived}/${total} indexed`);
    }
  }

  result.archived = archived;
  return result;
}

export async function runSyncCli(): Promise<void> {
  const db = openDatabase();
  try {
    const result = await syncTranscripts(db);
    log.info(`Done.`, { ...result });
  } finally {
    db.close();
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
