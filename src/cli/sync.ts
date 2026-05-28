import type { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import { openDatabase } from '../core/db.js';
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
  archivePath: string;
}

export async function syncTranscripts(db: Database): Promise<SyncResult> {
  const archiveDir = getArchiveDir();
  const archiveFiles = new Map<string, ArchiveFile>();
  let copied = 0;

  for (const adapter of getBuiltInSourceAdapters()) {
    for (const root of adapter.roots()) {
      for (const sourcePath of findJsonlFiles(root, adapter)) {
        const archivePath = path.join(archiveDir, adapter.kind, path.relative(root, sourcePath));
        if (copyIfNewer(sourcePath, archivePath)) {
          copied++;
        }
        if (existsSync(archivePath)) {
          archiveFiles.set(archivePath, { adapter, archivePath });
        }
      }
    }

    const adapterArchiveRoot = path.join(archiveDir, adapter.kind);
    if (existsSync(adapterArchiveRoot)) {
      for (const archivePath of findJsonlFiles(adapterArchiveRoot, adapter)) {
        archiveFiles.set(archivePath, { adapter, archivePath });
      }
    }
  }

  let indexed = 0;
  for (const file of archiveFiles.values()) {
    await reindexArchiveFile(db, file.archivePath, file.adapter.kind, file.adapter.parse);
    indexed++;
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
    console.log(`Done. copied=${result.copied} indexed=${result.indexed} skipped=${result.skipped}`);
  } finally {
    db.close();
  }
}

function findJsonlFiles(root: string, adapter: SourceAdapter): string[] {
  const files: string[] = [];
  if (existsSync(path.join(root, '.no-memmem'))) {
    return files;
  }

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
