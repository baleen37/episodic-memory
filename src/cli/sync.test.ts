import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase } from '../core/db.js';
import { __setModelForTests } from '../core/embeddings.js';
import { syncTranscripts } from './sync.js';

let dir: string | null = null;
let db: ReturnType<typeof initDatabase> | null = null;
const originalEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  TEST_ARCHIVE_DIR: process.env.TEST_ARCHIVE_DIR,
  TEST_DB_PATH: process.env.TEST_DB_PATH,
  CONVERSATION_MEMORY_DB_PATH: process.env.CONVERSATION_MEMORY_DB_PATH,
  MEMMEM_DB_PATH: process.env.MEMMEM_DB_PATH,
};

afterEach(() => {
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  restoreEnv('CLAUDE_CONFIG_DIR');
  restoreEnv('CODEX_HOME');
  restoreEnv('TEST_ARCHIVE_DIR');
  restoreEnv('TEST_DB_PATH');
  restoreEnv('CONVERSATION_MEMORY_DB_PATH');
  restoreEnv('MEMMEM_DB_PATH');
  __setModelForTests(null, null);
});

describe('syncTranscripts', () => {
  test('copies Claude and Codex transcripts under source kind prefixes and indexes them', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();

    mkdirSync(join(claudeDir, 'projects', 'proj'), { recursive: true });
    mkdirSync(join(codexDir, 'sessions'), { recursive: true });

    writeClaudeTranscript(join(claudeDir, 'projects', 'proj', 'session.jsonl'), 'Question', 'Answer');

    writeFileSync(join(codexDir, 'sessions', 'rollout.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'c1', cwd: '/repo' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run tests' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Passed' }] } }),
    ].join('\n'));

    setupEnv(claudeDir, codexDir, archiveDir);
    db = initDatabase();
    setGoodEmbeddingModel();

    const result = await syncTranscripts(db);

    expect(result.copied).toBe(2);
    expect(result.indexed).toBe(2);
    expect(existsSync(join(archiveDir, 'claude-projects', 'proj', 'session.jsonl'))).toBe(true);
    expect(existsSync(join(archiveDir, 'codex-sessions', 'rollout.jsonl'))).toBe(true);
  });

  test('retries archive reindexing after a prior copied archive did not update the DB', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const sourcePath = join(claudeDir, 'projects', 'proj', 'session.jsonl');
    const archivePath = join(archiveDir, 'claude-projects', 'proj', 'session.jsonl');
    mkdirSync(join(claudeDir, 'projects', 'proj'), { recursive: true });

    writeClaudeTranscript(sourcePath, 'Old question', 'Old answer');
    setupEnv(claudeDir, codexDir, archiveDir);
    db = initDatabase();
    setGoodEmbeddingModel();
    await syncTranscripts(db);

    writeClaudeTranscript(sourcePath, 'New question', 'New answer');
    writeClaudeTranscript(archivePath, 'New question', 'New answer');
    const future = new Date(Date.now() + 1000);
    utimesSync(archivePath, future, future);

    const result = await syncTranscripts(db);
    const row = db.query('SELECT user_text FROM exchanges WHERE archive_path = ?').get(archivePath) as { user_text: string };

    expect(result.indexed).toBe(1);
    expect(row.user_text).toBe('New question');
  });

  test('reindexes archive-only files when vectors are missing', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const sourcePath = join(claudeDir, 'projects', 'proj', 'session.jsonl');
    mkdirSync(join(claudeDir, 'projects', 'proj'), { recursive: true });
    writeClaudeTranscript(sourcePath, 'Archive question', 'Archive answer');
    setupEnv(claudeDir, codexDir, archiveDir);
    db = initDatabase();
    setGoodEmbeddingModel();
    await syncTranscripts(db);

    unlinkSync(sourcePath);
    db.query('DELETE FROM vec_exchanges').run();

    const result = await syncTranscripts(db);
    const vectorCount = db.query('SELECT COUNT(*) AS count FROM vec_exchanges').get() as { count: number };

    expect(result.indexed).toBe(1);
    expect(vectorCount.count).toBe(1);
  });

  test('counts indexed as archive files, not exchanges', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const sourcePath = join(claudeDir, 'projects', 'proj', 'session.jsonl');
    mkdirSync(join(claudeDir, 'projects', 'proj'), { recursive: true });
    writeFileSync(sourcePath, [
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:00.000Z', sessionId: 's1', message: { role: 'user', content: 'First question' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:01.000Z', sessionId: 's1', message: { role: 'assistant', content: 'First answer' } }),
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:02.000Z', sessionId: 's1', message: { role: 'user', content: 'Second question' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:03.000Z', sessionId: 's1', message: { role: 'assistant', content: 'Second answer' } }),
    ].join('\n'));
    setupEnv(claudeDir, codexDir, archiveDir);
    db = initDatabase();
    setGoodEmbeddingModel();

    const result = await syncTranscripts(db);
    const exchangeCount = db.query('SELECT COUNT(*) AS count FROM exchanges').get() as { count: number };

    expect(result.indexed).toBe(1);
    expect(exchangeCount.count).toBe(2);
  });

  test('does not copy or index transcripts below a .no-memmem directory', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const ignoredDir = join(claudeDir, 'projects', 'ignored');
    const sourcePath = join(ignoredDir, 'session.jsonl');
    mkdirSync(ignoredDir, { recursive: true });
    writeFileSync(join(ignoredDir, '.no-memmem'), '');
    writeClaudeTranscript(sourcePath, 'Secret question', 'Secret answer');
    setupEnv(claudeDir, codexDir, archiveDir);
    db = initDatabase();
    setGoodEmbeddingModel();

    const result = await syncTranscripts(db);
    const exchangeCount = db.query('SELECT COUNT(*) AS count FROM exchanges').get() as { count: number };

    expect(result.copied).toBe(0);
    expect(result.indexed).toBe(0);
    expect(exchangeCount.count).toBe(0);
    expect(existsSync(join(archiveDir, 'claude-projects', 'ignored', 'session.jsonl'))).toBe(false);
  });

  test('purges archived indexes when a synced source directory becomes excluded', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const sourceDir = join(claudeDir, 'projects', 'proj');
    const sourcePath = join(sourceDir, 'session.jsonl');
    const archivePath = join(archiveDir, 'claude-projects', 'proj', 'session.jsonl');
    mkdirSync(sourceDir, { recursive: true });
    writeClaudeTranscript(sourcePath, 'Secret question', 'Secret answer');
    setupEnv(claudeDir, codexDir, archiveDir);
    db = initDatabase();
    setGoodEmbeddingModel();
    await syncTranscripts(db);

    writeFileSync(join(sourceDir, '.no-memmem'), '');

    const result = await syncTranscripts(db);
    const exchangeCount = db.query('SELECT COUNT(*) AS count FROM exchanges WHERE archive_path = ?').get(archivePath) as { count: number };

    expect(result.indexed).toBe(0);
    expect(exchangeCount.count).toBe(0);
    expect(existsSync(archivePath)).toBe(false);
  });
});

function setupDirs(): { claudeDir: string; codexDir: string; archiveDir: string } {
  dir = mkdtempSync(join(tmpdir(), 'memmem-sync-'));
  return {
    claudeDir: join(dir, '.claude'),
    codexDir: join(dir, '.codex'),
    archiveDir: join(dir, 'archive'),
  };
}

function setupEnv(claudeDir: string, codexDir: string, archiveDir: string): void {
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexDir;
  process.env.TEST_ARCHIVE_DIR = archiveDir;
  process.env.TEST_DB_PATH = ':memory:';
  process.env.CONVERSATION_MEMORY_DB_PATH = ':memory:';
  delete process.env.MEMMEM_DB_PATH;
}

function setGoodEmbeddingModel(): void {
  __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));
}

function writeClaudeTranscript(filePath: string, userText: string, assistantText: string): void {
  writeFileSync(filePath, [
    JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:00.000Z', sessionId: 's1', message: { role: 'user', content: userText } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:01.000Z', sessionId: 's1', message: { role: 'assistant', content: assistantText } }),
  ].join('\n'));
}

function restoreEnv(key: keyof typeof originalEnv): void {
  const value = originalEnv[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
