import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runDoctorCli } from './doctor.js';

describe('runDoctorCli', () => {
  let dir: string | null = null;

  afterEach(() => {
    delete process.env.EPISODIC_MEMORY_DB_PATH;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test('runs against a fresh, nonexistent database path without a "no such table" error', () => {
    dir = mkdtempSync(join(tmpdir(), 'episodic-memory-doctor-cli-'));
    process.env.EPISODIC_MEMORY_DB_PATH = join(dir, 'fresh.db');

    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (value?: unknown) => { lines.push(String(value ?? '')); };
    try {
      expect(() => runDoctorCli()).not.toThrow();
    } finally {
      console.log = originalLog;
    }

    expect(lines.join('\n')).not.toContain('no such table');
  });
});
