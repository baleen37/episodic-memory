import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase } from '../core/db.js';
import { __setModelForTests } from '../core/embeddings.js';
import { syncTranscripts } from './sync.js';

let dir: string | null = null;
let db: ReturnType<typeof initDatabase> | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.TEST_ARCHIVE_DIR;
  delete process.env.TEST_DB_PATH;
  __setModelForTests(null, null);
});

describe('syncTranscripts', () => {
  test('copies Claude and Codex transcripts under source kind prefixes and indexes them', async () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-sync-'));
    const claudeDir = join(dir, '.claude');
    const codexDir = join(dir, '.codex');
    const archiveDir = join(dir, 'archive');

    mkdirSync(join(claudeDir, 'projects', 'proj'), { recursive: true });
    mkdirSync(join(codexDir, 'sessions'), { recursive: true });

    writeFileSync(join(claudeDir, 'projects', 'proj', 'session.jsonl'), [
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:00.000Z', sessionId: 's1', message: { role: 'user', content: 'Question' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:01.000Z', sessionId: 's1', message: { role: 'assistant', content: 'Answer' } }),
    ].join('\n'));

    writeFileSync(join(codexDir, 'sessions', 'rollout.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'c1', cwd: '/repo' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run tests' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Passed' }] } }),
    ].join('\n'));

    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.CODEX_HOME = codexDir;
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));

    const result = await syncTranscripts(db);

    expect(result.copied).toBe(2);
    expect(result.indexed).toBe(2);
    expect(existsSync(join(archiveDir, 'claude-projects', 'proj', 'session.jsonl'))).toBe(true);
    expect(existsSync(join(archiveDir, 'codex-sessions', 'rollout.jsonl'))).toBe(true);
  });
});
