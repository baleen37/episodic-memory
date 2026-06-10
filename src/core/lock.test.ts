import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { acquireSyncLock } from './lock.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'memmem-lock-'));
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

  test('reclaims a stale lock (mtime older than ceiling)', () => {
    const first = acquireSyncLock();
    expect(first).not.toBeNull();
    // Age the lock dir well past the 30-minute ceiling.
    const lockPath = path.join(dir, 'conversation-index', 'sync.lock');
    const old = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(lockPath, old, old);
    // A fresh acquire sees EEXIST, finds it stale, reclaims it.
    const second = acquireSyncLock();
    expect(second).not.toBeNull();
    second!();
    // Do not call first!() — its dir was reclaimed; release must be safe anyway.
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
