/**
 * Integration tests for observe-cli session_id handling.
 *
 * These tests run the actual CLI binary to verify that session_id from stdin
 * JSON is used when environment variables are not set.
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase } from '../core/db.js';

const CLI_PATH = new URL('../../dist/cli.mjs', import.meta.url).pathname;

describe('observe-cli session_id integration', () => {
  let dbPath: string;
  let tempDir: string;

  beforeAll(() => {
    // Debug: verify CLI exists
    if (!fs.existsSync(CLI_PATH)) {
      throw new Error(`CLI not found at ${CLI_PATH}. Run 'npm run build' first.`);
    }
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memmem-test-'));
    dbPath = path.join(tempDir, 'conversations.db');
    // Set env var BEFORE calling initDatabase so it uses our test path
    process.env.MEMMEM_DB_PATH = dbPath;
    const db = initDatabase();
    db.close();
  });

  afterEach(() => {
    delete process.env.MEMMEM_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('stores session_id from stdin JSON when env var is absent', () => {
    const sessionId = 'stdin-session-abc-12345';
    const stdinPayload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: 'file.ts\nother.ts',
      session_id: sessionId,
    });

    const result = spawnSync('node', [CLI_PATH, 'observe'], {
      input: stdinPayload,
      env: {
        ...process.env,
        MEMMEM_DB_PATH: dbPath,
        // Explicitly unset session env vars
        CLAUDE_SESSION_ID: undefined,
        CLAUDE_SESSION: undefined,
      },
      encoding: 'utf8',
    });

    // Debug: always log CLI output
    console.log('CLI stdout:', result.stdout);
    console.log('CLI stderr:', result.stderr);
    console.log('CLI status:', result.status);
    console.log('CLI error:', result.error);
    console.log('dbPath:', dbPath);
    console.log('fs.existsSync(dbPath):', fs.existsSync(dbPath));

    expect(result.status).toBe(0);

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT session_id FROM pending_events').all() as Array<{ session_id: string }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe(sessionId);
  });

  test('does not store unknown as session_id when stdin has session_id', () => {
    const stdinPayload = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/src/test.ts' },
      tool_response: 'content',
      session_id: 'real-session-xyz',
    });

    const result = spawnSync('node', [CLI_PATH, 'observe'], {
      input: stdinPayload,
      env: {
        ...process.env,
        MEMMEM_DB_PATH: dbPath,
        CLAUDE_SESSION_ID: undefined,
        CLAUDE_SESSION: undefined,
      },
      encoding: 'utf8',
    });

    // Debug: always log CLI output
    console.log('CLI stdout:', result.stdout);
    console.log('CLI stderr:', result.stderr);
    console.log('CLI status:', result.status);
    console.log('CLI error:', result.error);
    console.log('dbPath:', dbPath);
    console.log('fs.existsSync(dbPath):', fs.existsSync(dbPath));

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT session_id FROM pending_events').all() as Array<{ session_id: string }>;
    db.close();

    const unknownRows = rows.filter(r => r.session_id === 'unknown');
    expect(unknownRows).toHaveLength(0);
  });
});
