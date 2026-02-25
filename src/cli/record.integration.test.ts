/**
 * Integration tests for record.ts session_id handling.
 *
 * These tests run the actual CLI binary to verify that session_id from stdin
 * JSON is used when environment variables are not set.
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase } from '../core/db.js';

const CLI_PATH = new URL('../../dist/cli.mjs', import.meta.url).pathname;

describe('record session_id integration', () => {
  let dbPath: string;
  let tempDir: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI_PATH)) {
      throw new Error(`CLI not found at ${CLI_PATH}. Run 'npm run build' first.`);
    }
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memmem-test-'));
    dbPath = path.join(tempDir, 'conversations.db');
    process.env.CONVERSATION_MEMORY_DB_PATH = dbPath;
    process.env.MEMMEM_DB_PATH = dbPath;
    const db = initDatabase();
    db.close();
  });

  afterEach(() => {
    delete process.env.CONVERSATION_MEMORY_DB_PATH;
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

    const result = spawnSync('bun', [CLI_PATH, 'record'], {
      input: stdinPayload,
      env: {
        ...process.env,
        CONVERSATION_MEMORY_DB_PATH: dbPath,
        MEMMEM_DB_PATH: dbPath,
        CLAUDE_SESSION_ID: undefined,
        CLAUDE_SESSION: undefined,
      },
      encoding: 'utf8',
    });

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

    const result = spawnSync('bun', [CLI_PATH, 'record'], {
      input: stdinPayload,
      env: {
        ...process.env,
        CONVERSATION_MEMORY_DB_PATH: dbPath,
        MEMMEM_DB_PATH: dbPath,
        CLAUDE_SESSION_ID: undefined,
        CLAUDE_SESSION: undefined,
      },
      encoding: 'utf8',
    });

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
