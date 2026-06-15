import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CURRENT_EMBEDDING_VERSION, CURRENT_EXTRACTION_VERSION, initDatabase, insertMemoryRecord, insertMemoryRecordVector, upsertExtractionState } from '../core/db.js';
import { __setModelForTests } from '../core/embeddings.js';
import { acquireSyncLock } from '../core/lock.js';
import { __setLoadConfigForTests, resetRateLimiters } from '../core/ratelimiter.js';
import { EXTRACTION_BUDGET_PER_SYNC, syncTranscripts } from './sync.js';
import type { LLMProvider } from '../core/llm/types.js';

let dir: string | null = null;
let db: ReturnType<typeof initDatabase> | null = null;
const originalEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  TEST_ARCHIVE_DIR: process.env.TEST_ARCHIVE_DIR,
  TEST_DB_PATH: process.env.TEST_DB_PATH,
  CONVERSATION_MEMORY_DB_PATH: process.env.CONVERSATION_MEMORY_DB_PATH,
  MEMMEM_DB_PATH: process.env.MEMMEM_DB_PATH,
  HOME: process.env.HOME,
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
  restoreEnv('HOME');
  __setModelForTests(null, null);
  __setLoadConfigForTests(null);
  resetRateLimiters();
});

/** Make embedding/LLM rate limiters effectively unbounded for fast tests. */
function setFastRateLimits(): void {
  __setLoadConfigForTests((() => ({
    ratelimit: {
      embedding: { requestsPerSecond: 1000, burstSize: 1000 },
      llm: { requestsPerSecond: 1000, burstSize: 1000 },
    },
  })) as Parameters<typeof __setLoadConfigForTests>[0]);
  resetRateLimiters();
}

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
    expect(result.archived).toBe(2);
    expect(result.spansConsidered).toBe(2);
    expect(result.spansSkipped).toBe(2);
    expect(result.memoryRecordsIndexed).toBe(0);
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
    const memoryCount = db.query('SELECT COUNT(*) AS count FROM memory_records WHERE archive_path = ?').get(archivePath) as { count: number };

    expect(result.archived).toBe(1);
    expect(result.spansConsidered).toBe(1);
    expect(result.spansSkipped).toBe(1);
    expect(memoryCount.count).toBe(0);
  });

  test('reindexes archive-only files when provider is missing and keeps memory rows unchanged', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const sourcePath = join(claudeDir, 'projects', 'proj', 'session.jsonl');
    const archivePath = join(archiveDir, 'claude-projects', 'proj', 'session.jsonl');
    mkdirSync(join(claudeDir, 'projects', 'proj'), { recursive: true });
    writeClaudeTranscript(sourcePath, 'Archive question', 'Archive answer');
    setupEnv(claudeDir, codexDir, archiveDir);
    db = initDatabase();
    setGoodEmbeddingModel();
    await syncTranscripts(db);
    seedMemoryRecord(db, archivePath);

    unlinkSync(sourcePath);
    db.query('DELETE FROM vec_memory_records').run();

    const result = await syncTranscripts(db);
    const memoryCount = db.query('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number };
    const vectorCount = db.query('SELECT COUNT(*) AS count FROM vec_memory_records').get() as { count: number };

    expect(result.archived).toBe(1);
    expect(result.spansSkipped).toBe(1);
    expect(memoryCount.count).toBe(1);
    expect(vectorCount.count).toBe(0);
  });

  test('counts archived files separately from transcript spans', async () => {
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
    const memoryCount = db.query('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number };

    expect(result.archived).toBe(1);
    expect(result.spansConsidered).toBe(2);
    expect(result.spansSkipped).toBe(2);
    expect(memoryCount.count).toBe(0);
  });

  test('copies archives without memory rows when LLM provider is missing', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const sourcePath = join(claudeDir, 'projects', 'proj', 'session.jsonl');
    mkdirSync(join(claudeDir, 'projects', 'proj'), { recursive: true });
    writeClaudeTranscript(sourcePath, 'Provider question', 'Provider answer');
    setupEnv(claudeDir, codexDir, archiveDir);
    db = initDatabase();
    setGoodEmbeddingModel();

    const result = await syncTranscripts(db);
    const memoryCount = db.query('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number };

    expect(result.copied).toBe(1);
    expect(result.archived).toBe(1);
    expect(result.spansConsidered).toBe(1);
    expect(result.spansSkipped).toBe(1);
    expect(result.memoryRecordsIndexed).toBe(0);
    expect(memoryCount.count).toBe(0);
    expect(existsSync(join(archiveDir, 'claude-projects', 'proj', 'session.jsonl'))).toBe(true);
  });

  test('continues syncing other archives when a source transcript copy fails', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const failingSourceDir = join(claudeDir, 'projects', 'blocked');
    const otherSourceDir = join(claudeDir, 'projects', 'proj');
    const failingSourcePath = join(failingSourceDir, 'session.jsonl');
    const existingSourcePath = join(otherSourceDir, 'existing.jsonl');
    const otherSourcePath = join(otherSourceDir, 'other.jsonl');
    const existingArchivePath = join(archiveDir, 'claude-projects', 'proj', 'existing.jsonl');
    const blockedArchivePath = join(archiveDir, 'claude-projects', 'blocked');
    mkdirSync(failingSourceDir, { recursive: true });
    mkdirSync(otherSourceDir, { recursive: true });
    writeClaudeTranscript(failingSourcePath, 'Failing question', 'Failing answer');
    writeClaudeTranscript(existingSourcePath, 'Existing question', 'Existing answer');
    writeClaudeTranscript(otherSourcePath, 'Other question', 'Other answer');
    mkdirSync(join(archiveDir, 'claude-projects', 'proj'), { recursive: true });
    writeClaudeTranscript(existingArchivePath, 'Archived question', 'Archived answer');
    writeFileSync(blockedArchivePath, 'not a directory');
    const future = new Date(Date.now() + 1000);
    utimesSync(existingArchivePath, future, future);
    setupEnv(claudeDir, codexDir, archiveDir);
    db = initDatabase();
    setGoodEmbeddingModel();

    const result = await syncTranscripts(db);

    expect(result.copied).toBe(1);
    expect(result.archived).toBe(2);
    expect(result.spansConsidered).toBe(2);
    expect(result.spansSkipped).toBe(2);
    expect(existsSync(join(archiveDir, 'claude-projects', 'blocked', 'session.jsonl'))).toBe(false);
    expect(existsSync(existingArchivePath)).toBe(true);
    expect(existsSync(join(archiveDir, 'claude-projects', 'proj', 'other.jsonl'))).toBe(true);
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
    const memoryCount = db.query('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number };

    expect(result.copied).toBe(0);
    expect(result.archived).toBe(0);
    expect(memoryCount.count).toBe(0);
    expect(existsSync(join(archiveDir, 'claude-projects', 'ignored', 'session.jsonl'))).toBe(false);
  });

  test('skips reparsing an unchanged, fully-indexed archive on the next sync', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const sourcePath = join(claudeDir, 'projects', 'proj', 'session.jsonl');
    mkdirSync(join(claudeDir, 'projects', 'proj'), { recursive: true });
    writeClaudeTranscript(sourcePath, 'Question', 'Answer');
    setupEnv(claudeDir, codexDir, archiveDir);
    db = initDatabase();
    setGoodEmbeddingModel();
    const provider = makeProvider();

    // First sync archives + fully indexes the file (provider present → extraction completes).
    const first = await syncTranscripts(db, { provider });
    expect(first.archived).toBe(1);

    // Second sync with nothing changed: the file is unchanged and fully indexed,
    // so it must not be reconsidered at all.
    const second = await syncTranscripts(db, { provider });

    expect(second.copied).toBe(0);
    expect(second.archived).toBe(0);
    expect(second.spansConsidered).toBe(0);
  });

  test('caps extractions per sync and defers the rest to the next sync', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const projDir = join(claudeDir, 'projects', 'proj');
    mkdirSync(projDir, { recursive: true });
    // EXTRACTION_BUDGET_PER_SYNC + a few extra spans across files.
    const fileCount = EXTRACTION_BUDGET_PER_SYNC + 3;
    for (let i = 0; i < fileCount; i++) {
      writeClaudeTranscript(join(projDir, `session-${i}.jsonl`), `Q${i}`, `A${i}`);
    }
    setupEnv(claudeDir, codexDir, archiveDir);
    db = initDatabase();
    setGoodEmbeddingModel();
    setFastRateLimits();
    const provider = makeProvider();

    const first = await syncTranscripts(db, { provider });
    // Budget caps how many files are fully processed in one run.
    expect(first.archived).toBeLessThanOrEqual(EXTRACTION_BUDGET_PER_SYNC);

    // The next sync picks up the deferred files without redoing finished ones.
    const second = await syncTranscripts(db, { provider });
    expect(second.archived).toBeGreaterThan(0);

    // Eventually everything is indexed and a final sync is a no-op.
    for (let i = 0; i < 5; i++) await syncTranscripts(db, { provider });
    const idle = await syncTranscripts(db, { provider });
    expect(idle.archived).toBe(0);
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
    seedMemoryRecord(db, archivePath);

    writeFileSync(join(sourceDir, '.no-memmem'), '');

    const result = await syncTranscripts(db);
    const memoryCount = db.query('SELECT COUNT(*) AS count FROM memory_records WHERE archive_path = ?').get(archivePath) as { count: number };
    const stateCount = db.query('SELECT COUNT(*) AS count FROM extraction_state WHERE archive_path = ?').get(archivePath) as { count: number };

    expect(result.archived).toBe(0);
    expect(memoryCount.count).toBe(0);
    expect(stateCount.count).toBe(0);
    expect(existsSync(archivePath)).toBe(false);
  });
});

describe('runSyncCli lock', () => {
  let lockDir: string;
  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), 'memmem-synclock-'));
    process.env.CONVERSATION_MEMORY_CONFIG_DIR = lockDir;
    process.env.CLAUDE_CONFIG_DIR = join(lockDir, 'claude');
    process.env.CODEX_HOME = join(lockDir, 'codex');
  });
  afterEach(() => {
    delete process.env.CONVERSATION_MEMORY_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    rmSync(lockDir, { recursive: true, force: true });
  });

  test('skips work when the lock is already held', async () => {
    const held = acquireSyncLock();
    expect(held).not.toBeNull();

    const { runSyncCli } = await import('./sync.js');
    await expect(runSyncCli()).resolves.toBeUndefined();

    // Lock still held → runSyncCli must NOT have acquired/released it.
    const second = acquireSyncLock();
    expect(second).toBeNull();

    held!();
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
  process.env.HOME = dir ?? claudeDir;
  delete process.env.MEMMEM_DB_PATH;
}

function setGoodEmbeddingModel(): void {
  __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));
}

function makeProvider(): LLMProvider {
  return {
    async complete() {
      return {
        text: JSON.stringify([{ kind: 'fact', text: 'Durable fact.', confidence: 1 }]),
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
}

function writeClaudeTranscript(filePath: string, userText: string, assistantText: string): void {
  writeFileSync(filePath, [
    JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:00.000Z', sessionId: 's1', message: { role: 'user', content: userText } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:01.000Z', sessionId: 's1', message: { role: 'assistant', content: assistantText } }),
  ].join('\n'));
}

function seedMemoryRecord(database: ReturnType<typeof initDatabase>, archivePath: string): void {
  const id = insertMemoryRecord(database, {
    kind: 'fact',
    text: 'Seeded memory record.',
    sourceKind: 'claude-projects',
    archivePath,
    lineStart: 1,
    lineEnd: 2,
    observedAt: Date.parse('2026-05-26T00:00:00.000Z'),
    project: 'proj',
    projectName: null,
    dedupeKey: `seed:${archivePath}`,
    extractionVersion: CURRENT_EXTRACTION_VERSION,
    embeddingVersion: CURRENT_EMBEDDING_VERSION,
  });
  insertMemoryRecordVector(database, id, Array.from({ length: 384 }, () => 0.1));
  upsertExtractionState(database, {
    sourceKind: 'claude-projects',
    archivePath,
    lineStart: 1,
    lineEnd: 2,
    sourceHash: 'seed-hash',
    extractionVersion: CURRENT_EXTRACTION_VERSION,
    status: 'done',
  });
}

function restoreEnv(key: keyof typeof originalEnv): void {
  const value = originalEnv[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
