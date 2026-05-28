import type { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import { deleteExchangeIndexForArchivePathPrefix, openDatabase } from '../core/db.js';
import { reindexArchiveFile } from '../core/indexer.js';
import { log } from '../core/logger.js';
import { getArchiveDir } from '../core/paths.js';
import { getBuiltInSourceAdapters, type SourceAdapter } from '../core/sources/index.js';

export interface SyncResult {
  copied: number;
  indexed: number;
  skipped: number;
}

interface ArchiveFile {
  adapter: SourceAdapter;
  archivePath: string;
}

export async function syncTranscripts(db: Database): Promise<SyncResult> {
  const archiveDir = getArchiveDir();
  const archiveFiles = new Map<string, ArchiveFile>();
  let copied = 0;

  for (const adapter of getBuiltInSourceAdapters()) {
    for (const root of adapter.roots()) {
      const excludedSourceDirs: string[] = [];
      for (const sourcePath of findJsonlFiles(root, adapter, excludedSourceDirs)) {
        const archivePath = path.join(archiveDir, adapter.kind, path.relative(root, sourcePath));
        if (copyIfNewer(sourcePath, archivePath)) {
          copied++;
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

  let indexed = 0;
  const progressInterval = Math.max(1, Math.floor(total / 20));
  for (const file of archiveFiles.values()) {
    await reindexArchiveFile(db, file.archivePath, file.adapter.kind, file.adapter.parse);
    indexed++;
    if (indexed % progressInterval === 0 || indexed === total) {
      log.info(`  ${indexed}/${total} indexed`);
    }
  }

  return {
    copied,
    indexed,
    skipped: 0,
  };
}

export async function runSyncCli(): Promise<void> {
  const db = openDatabase();
  try {
    const result = await syncTranscripts(db);
    log.info(`Done.`, { copied: result.copied, indexed: result.indexed, skipped: result.skipped });
  } finally {
    db.close();
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
  deleteExchangeIndexForArchivePathPrefix(db, archivePathPrefix);
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
