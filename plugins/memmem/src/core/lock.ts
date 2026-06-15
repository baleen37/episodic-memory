import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { getIndexDir } from './paths.js';
import { log } from './logger.js';

/**
 * Fallback ceiling for when the holder's liveness cannot be determined
 * (no/garbled pid file). A lock older than this is treated as abandoned.
 * The primary signal is PID liveness (see isAbandoned); this only catches
 * locks whose pid file is missing or unreadable.
 */
const STALE_MS = 30 * 60 * 1000;

function lockPath(): string {
  return path.join(getIndexDir(), 'sync.lock');
}

function tryCreate(lockDir: string): boolean {
  try {
    mkdirSync(lockDir); // atomic; throws EEXIST if held
    writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

/** Read the holder PID from the lock dir, or null if missing/garbled. */
function readHolderPid(lockDir: string): number | null {
  try {
    const pid = Number(readFileSync(path.join(lockDir, 'pid'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** True if no process with this PID is currently running. */
function isProcessDead(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, does not kill
    return false;
  } catch (error) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Decide whether a held lock can be reclaimed.
 * Primary signal: the holder PID is dead → abandoned, reclaim immediately
 * regardless of age. This prevents a slow-but-live sync from having its lock
 * stolen (which previously caused concurrent syncs to pile up). When the PID
 * is unknown, fall back to the mtime-age ceiling.
 */
function isAbandoned(lockDir: string): boolean {
  const pid = readHolderPid(lockDir);
  if (pid !== null) {
    return isProcessDead(pid);
  }
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

  // Held. Reclaim only if the holder looks abandoned (dead PID, or stale by
  // age when the PID is unknown).
  if (isAbandoned(lockDir)) {
    log.warn('Reclaiming abandoned sync lock', { lockDir });
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
