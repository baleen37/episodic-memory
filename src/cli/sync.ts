import type { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs';
import path from 'path';
import { getArchivePathsNeedingReindex, openDatabase } from '../core/db.js';
import { reindexArchiveFile } from '../core/indexer.js';
import { getArchiveDir } from '../core/paths.js';
import { getBuiltInSourceAdapters, type SourceAdapter } from '../core/sources/index.js';

export interface SyncResult {
  copied: number;
  indexed: number;
  skipped: number;
}

interface ArchiveFile {
  adapter: SourceAdapter;
  sourcePath: string;
  archivePath: string;
}

export async function syncTranscripts(db: Database): Promise<SyncResult> {
  const archiveDir = getArchiveDir();
  const archiveFiles: ArchiveFile[] = [];
  const copiedPaths = new Set<string>();
  let copied = 0;

  for (const adapter of getBuiltInSourceAdapters()) {
    for (const root of adapter.roots()) {
      for (const sourcePath of findJsonlFiles(root, adapter)) {
        const relativePath = path.relative(root, sourcePath);
        const archivePath = path.join(archiveDir, adapter.kind, relativePath);
        archiveFiles.push({ adapter, sourcePath, archivePath });

        if (copyIfNewer(sourcePath, archivePath)) {
          copied++;
          copiedPaths.add(archivePath);
        }
      }
    }
  }

  const archivePaths = archiveFiles.map(file => file.archivePath);
  const needsReindex = new Set(getArchivePathsNeedingReindex(db, archivePaths));
  for (const archivePath of copiedPaths) {
    needsReindex.add(archivePath);
  }

  let indexed = 0;
  for (const archivePath of needsReindex) {
    const file = archiveFiles.find(candidate => candidate.archivePath === archivePath);
    if (!file) continue;
    indexed += await reindexArchiveFile(db, archivePath, file.adapter.kind, file.adapter.parse);
  }

  return {
    copied,
    indexed,
    skipped: archiveFiles.length - needsReindex.size,
  };
}

export async function runSyncCli(): Promise<void> {
  const db = openDatabase();
  try {
    const result = await syncTranscripts(db);
    console.log(`Done. copied=${result.copied} indexed=${result.indexed} skipped=${result.skipped}`);
  } finally {
    db.close();
  }
}

function findJsonlFiles(root: string, adapter: SourceAdapter): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonlFiles(entryPath, adapter));
    } else if (entry.isFile() && entryPath.endsWith('.jsonl') && adapter.detect(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

function copyIfNewer(sourcePath: string, destinationPath: string): boolean {
  if (existsSync(destinationPath) && statSync(destinationPath).mtimeMs >= statSync(sourcePath).mtimeMs) {
    return false;
  }

  mkdirSync(path.dirname(destinationPath), { recursive: true });
  const tmpPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  copyFileSync(sourcePath, tmpPath);
  renameSync(tmpPath, destinationPath);
  return true;
}

