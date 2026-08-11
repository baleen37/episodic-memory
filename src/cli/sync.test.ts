import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Database } from 'bun:sqlite';
import { initDatabase } from '../core/db.js';
import { createMemorySchema } from '../core/memory/schema.js';
import { __setModelForTests } from '../core/embeddings.js';
import { acquireSyncLock } from '../core/lock.js';
import { __setLoadConfigForTests, resetRateLimiters } from '../core/ratelimiter.js';
import { EXTRACTION_BUDGET_PER_SYNC, LOCAL_USER_ID, mapSourceToFilters, syncArchives } from './sync.js';
import type { LLMProvider } from '../core/llm/types.js';

describe('mapSourceToFilters', () => {
  test('maps source metadata onto mem0 scoping keys', () => {
    const filters = mapSourceToFilters({
      sourceKind: 'claude-code-projects',
      archivePath: '/archive/claude-code-projects/proj/abc123.jsonl',
    });
    expect(filters.agent_id).toBe('claude-code-projects');
    expect(filters.run_id).toBe('abc123');
    expect(filters.user_id).toBeDefined();
  });

  test('always produces at least one scoping key', () => {
    const filters = mapSourceToFilters({ sourceKind: 'codex-sessions', archivePath: '/a/b.jsonl' });
    expect(filters.user_id ?? filters.agent_id ?? filters.run_id).toBeDefined();
  });
});

let dir: string | null = null;
let db: Database | null = null;
const originalEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  TEST_ARCHIVE_DIR: process.env.TEST_ARCHIVE_DIR,
  TEST_DB_PATH: process.env.TEST_DB_PATH,
  CONVERSATION_MEMORY_DB_PATH: process.env.CONVERSATION_MEMORY_DB_PATH,
  MEMMEM_DB_PATH: process.env.MEMMEM_DB_PATH,
  HOME: process.env.HOME,
};

// Transitional: sync.ts runs both the legacy schema (db.ts, for archive_index_state
// incremental tracking) and the new mem0 schema (memory/schema.ts, for addMemories)
// on one connection until Task 11 removes the legacy schema entirely.
function freshMemoryDb(): Database {
  const database = initDatabase();
  createMemorySchema(database);
  return database;
}

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

describe('syncArchives', () => {
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
    db = freshMemoryDb();
    setGoodEmbeddingModel();

    const result = await syncArchives(db);

    expect(result.filesScanned).toBe(2);
    expect(result.filesIndexed).toBe(2);
    expect(result.memoriesAdded).toBe(0);
    expect(existsSync(join(archiveDir, 'claude-code-projects', 'proj', 'session.jsonl'))).toBe(true);
    expect(existsSync(join(archiveDir, 'codex-sessions', 'rollout.jsonl'))).toBe(true);
  });

  test('copies archives without memory rows when LLM provider is missing', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const sourcePath = join(claudeDir, 'projects', 'proj', 'session.jsonl');
    mkdirSync(join(claudeDir, 'projects', 'proj'), { recursive: true });
    writeClaudeTranscript(sourcePath, 'Provider question', 'Provider answer');
    setupEnv(claudeDir, codexDir, archiveDir);
    db = freshMemoryDb();
    setGoodEmbeddingModel();

    const result = await syncArchives(db);
    const memoryCount = (db.query('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count;

    expect(result.filesIndexed).toBe(1);
    expect(result.memoriesAdded).toBe(0);
    expect(memoryCount).toBe(0);
    expect(existsSync(join(archiveDir, 'claude-code-projects', 'proj', 'session.jsonl'))).toBe(true);
  });

  test('indexes memory records through addMemories when a provider is configured', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const sourcePath = join(claudeDir, 'projects', 'proj', 'session.jsonl');
    mkdirSync(join(claudeDir, 'projects', 'proj'), { recursive: true });
    writeClaudeTranscript(sourcePath, 'Durable question', 'Durable answer');
    setupEnv(claudeDir, codexDir, archiveDir);
    db = freshMemoryDb();
    setGoodEmbeddingModel();
    setFastRateLimits();
    const provider = makeProvider();

    const result = await syncArchives(db, { provider });
    const memoryCount = (db.query('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count;
    const metadata = JSON.parse((db.query('SELECT metadata FROM memories LIMIT 1').get() as { metadata: string }).metadata);

    expect(result.filesIndexed).toBe(1);
    expect(result.memoriesAdded).toBe(1);
    expect(memoryCount).toBe(1);
    expect(metadata.user_id).toBe(LOCAL_USER_ID);
    expect(metadata.agent_id).toBe('claude-code-projects');
    expect(metadata.run_id).toBe('session');
  });

  test('does not copy or index transcripts below a .no-memmem directory', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const ignoredDir = join(claudeDir, 'projects', 'ignored');
    const sourcePath = join(ignoredDir, 'session.jsonl');
    mkdirSync(ignoredDir, { recursive: true });
    writeFileSync(join(ignoredDir, '.no-memmem'), '');
    writeClaudeTranscript(sourcePath, 'Secret question', 'Secret answer');
    setupEnv(claudeDir, codexDir, archiveDir);
    db = freshMemoryDb();
    setGoodEmbeddingModel();

    const result = await syncArchives(db);
    const memoryCount = (db.query('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count;

    expect(result.filesScanned).toBe(0);
    expect(result.filesIndexed).toBe(0);
    expect(memoryCount).toBe(0);
    expect(existsSync(join(archiveDir, 'claude-code-projects', 'ignored', 'session.jsonl'))).toBe(false);
  });

  test('skips reparsing an unchanged, fully-indexed archive on the next sync', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const sourcePath = join(claudeDir, 'projects', 'proj', 'session.jsonl');
    mkdirSync(join(claudeDir, 'projects', 'proj'), { recursive: true });
    writeClaudeTranscript(sourcePath, 'Question', 'Answer');
    setupEnv(claudeDir, codexDir, archiveDir);
    db = freshMemoryDb();
    setGoodEmbeddingModel();
    setFastRateLimits();
    const provider = makeProvider();

    // First sync archives + fully indexes the file (provider present → extraction completes).
    const first = await syncArchives(db, { provider });
    expect(first.filesIndexed).toBe(1);

    // Second sync with nothing changed: the file is unchanged and fully indexed,
    // so it must be skipped, not reconsidered.
    const second = await syncArchives(db, { provider });

    expect(second.filesIndexed).toBe(0);
    expect(second.skipped).toBe(1);
  });

  test('reindexes an archive after its content changes', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const sourcePath = join(claudeDir, 'projects', 'proj', 'session.jsonl');
    const archivePath = join(archiveDir, 'claude-code-projects', 'proj', 'session.jsonl');
    mkdirSync(join(claudeDir, 'projects', 'proj'), { recursive: true });

    writeClaudeTranscript(sourcePath, 'Old question', 'Old answer');
    setupEnv(claudeDir, codexDir, archiveDir);
    db = freshMemoryDb();
    setGoodEmbeddingModel();
    await syncArchives(db);

    writeClaudeTranscript(sourcePath, 'New question', 'New answer');
    writeClaudeTranscript(archivePath, 'New question', 'New answer');
    const future = new Date(Date.now() + 1000);
    utimesSync(archivePath, future, future);

    const result = await syncArchives(db);

    expect(result.filesIndexed).toBe(1);
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
    db = freshMemoryDb();
    setGoodEmbeddingModel();
    setFastRateLimits();
    const provider = makeProvider();

    const first = await syncArchives(db, { provider });
    // Budget caps how many files are fully processed in one run.
    expect(first.filesIndexed).toBeLessThan(fileCount);

    // The next sync picks up the deferred files without redoing finished ones.
    const second = await syncArchives(db, { provider });
    expect(second.filesIndexed).toBeGreaterThan(0);

    // Eventually everything is indexed and a final sync is a no-op.
    for (let i = 0; i < 5; i++) await syncArchives(db, { provider });
    const idle = await syncArchives(db, { provider });
    expect(idle.filesIndexed).toBe(0);
  });

  test('purges archive files (but not their prior extraction bookkeeping) when a synced source directory becomes excluded', async () => {
    const { claudeDir, codexDir, archiveDir } = setupDirs();
    const sourceDir = join(claudeDir, 'projects', 'proj');
    const sourcePath = join(sourceDir, 'session.jsonl');
    const archivePath = join(archiveDir, 'claude-code-projects', 'proj', 'session.jsonl');
    mkdirSync(sourceDir, { recursive: true });
    writeClaudeTranscript(sourcePath, 'Secret question', 'Secret answer');
    setupEnv(claudeDir, codexDir, archiveDir);
    db = freshMemoryDb();
    setGoodEmbeddingModel();
    await syncArchives(db);

    writeFileSync(join(sourceDir, '.no-memmem'), '');

    const result = await syncArchives(db);

    expect(result.filesIndexed).toBe(0);
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
        text: JSON.stringify({ memory: [{ id: '0', text: 'Durable fact.', attributed_to: 'user' }] }),
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

function restoreEnv(key: keyof typeof originalEnv): void {
  const value = originalEnv[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
