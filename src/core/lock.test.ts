import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { acquireSyncLock } from './lock.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'episodic-memory-lock-'));
  // getIndexDir() reads from the config dir; CONVERSATION_MEMORY_CONFIG_DIR
  // overrides it. Point it at our temp dir so the lock lands there.
  process.env.CONVERSATION_MEMORY_CONFIG_DIR = dir;
});

afterEach(() => {
  delete process.env.CONVERSATION_MEMORY_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireSyncLock', () => {
  test('acquires when free and releases', () => {
    const release = acquireSyncLock();
    expect(release).not.toBeNull();
    release!();
    // After release, lock is acquirable again.
    const again = acquireSyncLock();
    expect(again).not.toBeNull();
    again!();
  });

  test('returns null when already held', () => {
    const first = acquireSyncLock();
    expect(first).not.toBeNull();
    const second = acquireSyncLock();
    expect(second).toBeNull();
    first!();
  });

  test('reclaims a stale lock (mtime older than ceiling) when PID is unknown', () => {
    const first = acquireSyncLock();
    expect(first).not.toBeNull();
    const lockPath = path.join(dir, 'conversation-index', 'sync.lock');
    // Remove the pid file so liveness cannot be determined — only then does
    // the mtime-age ceiling apply.
    rmSync(path.join(lockPath, 'pid'), { force: true });
    // Age the lock dir well past the 30-minute ceiling.
    const old = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(lockPath, old, old);
    // A fresh acquire sees EEXIST, finds it abandoned by age, reclaims it.
    const second = acquireSyncLock();
    expect(second).not.toBeNull();
    second!();
    // Do not call first!() — its dir was reclaimed; release must be safe anyway.
    first!();
  });

  test('reclaims a fresh lock whose holder PID is dead', () => {
    const first = acquireSyncLock();
    expect(first).not.toBeNull();
    // Overwrite the pid file with a PID that is guaranteed not to exist.
    // The lock mtime is fresh (well under the 30-min ceiling), so only a
    // liveness check can justify reclaiming it.
    const lockPath = path.join(dir, 'conversation-index', 'sync.lock');
    writeFileSync(path.join(lockPath, 'pid'), '2147483647');
    const second = acquireSyncLock();
    expect(second).not.toBeNull();
    second!();
    first!();
  });

  test('yields to a live holder even if mtime is past the stale ceiling', () => {
    const first = acquireSyncLock();
    expect(first).not.toBeNull();
    // Holder is our own (live) PID — written by acquireSyncLock.
    // Age the lock past the ceiling: mtime alone would reclaim it, but a live
    // holder must keep the lock to prevent concurrent syncs.
    const lockPath = path.join(dir, 'conversation-index', 'sync.lock');
    const old = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(lockPath, old, old);
    const second = acquireSyncLock();
    expect(second).toBeNull();
    first!();
  });

  test('release is safe even if lock dir already gone', () => {
    const release = acquireSyncLock();
    expect(release).not.toBeNull();
    const lockPath = path.join(dir, 'conversation-index', 'sync.lock');
    rmSync(lockPath, { recursive: true, force: true });
    expect(() => release!()).not.toThrow();
  });
});
