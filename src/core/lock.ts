import { mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { getIndexDir } from './paths.js';
import { log } from './logger.js';

/**
 * A lock older than this is treated as abandoned by a crashed holder.
 * Note: the holder does NOT refresh mtime, so a sync running longer than
 * this could have its lock reclaimed by a concurrent run. Acceptable for
 * this minimal lock — real syncs finish well under 30 minutes.
 */
const STALE_MS = 30 * 60 * 1000;

function lockPath(): string {
  return path.join(getIndexDir(), 'sync.lock');
}

function tryCreate(lockDir: string): boolean {
  try {
    mkdirSync(lockDir); // atomic; throws EEXIST if held
    // PID is written for diagnostics only — never used for liveness checks.
    writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

function isStale(lockDir: string): boolean {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Acquire the single-run sync lock.
 * Returns a release function, or null if another sync currently holds it.
 */
export function acquireSyncLock(): (() => void) | null {
  const lockDir = lockPath();

  if (tryCreate(lockDir)) {
    return makeRelease(lockDir);
  }

  // Held. Reclaim only if the holder looks crashed (stale by mtime age).
  if (isStale(lockDir)) {
    log.warn('Reclaiming stale sync lock', { lockDir });
    rmSync(lockDir, { recursive: true, force: true });
    if (tryCreate(lockDir)) {
      return makeRelease(lockDir);
    }
  }

  return null;
}

function makeRelease(lockDir: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(lockDir, { recursive: true, force: true });
  };
}
