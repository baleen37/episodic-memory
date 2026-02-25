/**
 * Tests for extract CLI - batch LLM extraction from buffered events into observations.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, getObservationById } from '../core/db.js';
import { recordEvent } from './record.js';
import { extractObservations, runExtract, type ExtractOptions, type ExtractCliDeps } from './extract.js';
import type { LLMProvider } from '../core/llm/index.js';

const TEST_SESSION_ID = 'test-session-123';
const TEST_PROJECT = 'test-project';

const createMockLLMProvider = () => ({
  complete: mock(async () => ({ text: '[]', usage: { input_tokens: 0, output_tokens: 0 } })),
} as unknown as LLMProvider);

let mockLLMProvider: LLMProvider;

function addReadEvents(db: Database, sessionId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    recordEvent(db, sessionId, TEST_PROJECT, 'Read', {
      file_path: `/src/file${i}.ts`,
      lines: 100,
    });
  }
}

function createExtractOptions(overrides?: Partial<ExtractOptions>): ExtractOptions {
  return {
    provider: mockLLMProvider,
    sessionId: TEST_SESSION_ID,
    project: TEST_PROJECT,
    createObservationFn: mock(async (db: Database, title: string, content: string, project: string, sessionId?: string, timestamp?: number, contentOriginal?: string) => {
      const now = Date.now();
      const result = db.prepare(`
        INSERT INTO observations (title, content, content_original, project, session_id, timestamp, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(title, content, contentOriginal ?? null, project, sessionId ?? null, timestamp ?? now, now);

      const rowid = Number(result.lastInsertRowid);
      const embedding = new Float32Array(384).fill(0.1);
      db.prepare(`
        INSERT INTO vec_observations (id, embedding)
        VALUES (?, ?)
      `).run(String(rowid), Buffer.from(embedding.buffer));

      return rowid;
    }) as unknown as typeof import('../core/db.js').createObservation,
    ...overrides,
  };
}

describe('extractObservations', () => {
  let db: Database;
  let tmpSrcDir: string;
  let tmpDstDir: string;

  beforeEach(() => {
    process.env.CONVERSATION_MEMORY_DB_PATH = ':memory:';
    db = initDatabase();
    mockLLMProvider = createMockLLMProvider();
    tmpSrcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memmem-src-'));
    tmpDstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memmem-dst-'));
  });

  afterEach(() => {
    if (db) db.close();
    fs.rmSync(tmpSrcDir, { recursive: true });
    fs.rmSync(tmpDstDir, { recursive: true });
  });

  test('skips extraction when less than 3 events', async () => {
    (mockLLMProvider.complete as ReturnType<typeof mock>).mockImplementation?.(async () => ({ text: '[]', usage: { input_tokens: 0, output_tokens: 0 } }));

    recordEvent(db, TEST_SESSION_ID, TEST_PROJECT, 'Read', { file_path: '/src/test.ts', lines: 100 });
    recordEvent(db, TEST_SESSION_ID, TEST_PROJECT, 'Bash', { command: 'echo test', exitCode: 0 });

    await extractObservations(db, createExtractOptions());

    expect(mockLLMProvider.complete).not.toHaveBeenCalled();
    expect(getObservationById(db, 1)).toBeNull();
  });

  test('extracts and stores observations when threshold is met', async () => {
    (mockLLMProvider.complete as ReturnType<typeof mock>).mockImplementation?.(async () => ({
      text: JSON.stringify([
        {
          title: 'Fixed auth bug',
          content: 'Resolved JWT validation issue',
          content_original: 'JWT 검증 문제를 해결함',
        },
      ]),
      usage: { input_tokens: 100, output_tokens: 20 },
    }));

    recordEvent(db, TEST_SESSION_ID, TEST_PROJECT, 'Read', { file_path: '/src/auth.ts', lines: 100 });
    recordEvent(db, TEST_SESSION_ID, TEST_PROJECT, 'Edit', {
      file_path: '/src/auth.ts',
      old_string: 'old',
      new_string: 'new',
    });
    recordEvent(db, TEST_SESSION_ID, TEST_PROJECT, 'Bash', { command: 'npm test', exitCode: 0 });

    await extractObservations(db, createExtractOptions());

    expect(mockLLMProvider.complete).toHaveBeenCalledTimes(1);

    const obs = getObservationById(db, 1);
    expect(obs).not.toBeNull();
    expect(obs?.title).toBe('Fixed auth bug');
    expect(obs?.content).toBe('Resolved JWT validation issue');
    expect(obs?.contentOriginal).toBe('JWT 검증 문제를 해결함');
    expect(obs?.sessionId).toBe(TEST_SESSION_ID);
    expect(obs?.project).toBe(TEST_PROJECT);
  });

  test('handles empty LLM response without storing observations', async () => {
    (mockLLMProvider.complete as ReturnType<typeof mock>).mockImplementation?.(async () => ({
      text: JSON.stringify([]),
      usage: { input_tokens: 50, output_tokens: 5 },
    }));

    addReadEvents(db, TEST_SESSION_ID, 3);

    await extractObservations(db, createExtractOptions());

    expect(mockLLMProvider.complete).toHaveBeenCalledTimes(1);
    expect(getObservationById(db, 1)).toBeNull();
  });

  test('handles LLM errors gracefully', async () => {
    (mockLLMProvider.complete as ReturnType<typeof mock>).mockImplementation?.(async () => { throw new Error('API error'); });

    addReadEvents(db, TEST_SESSION_ID, 3);

    await expect(extractObservations(db, createExtractOptions())).resolves.toBeUndefined();
    expect(getObservationById(db, 1)).toBeNull();
  });

  describe('batching behavior', () => {
    test('uses default batch size when batchSize is not provided', async () => {
      (mockLLMProvider.complete as ReturnType<typeof mock>).mockImplementation?.(async () => ({
        text: JSON.stringify([{ title: 'Test', content: 'Content' }]),
        usage: { input_tokens: 100, output_tokens: 20 },
      }));

      addReadEvents(db, TEST_SESSION_ID, 30);

      await extractObservations(db, createExtractOptions());

      expect(mockLLMProvider.complete).toHaveBeenCalledTimes(2);
    });

    test('uses custom batch size when provided', async () => {
      (mockLLMProvider.complete as ReturnType<typeof mock>).mockImplementation?.(async () => ({
        text: JSON.stringify([{ title: 'Test', content: 'Content' }]),
        usage: { input_tokens: 100, output_tokens: 20 },
      }));

      addReadEvents(db, TEST_SESSION_ID, 30);

      await extractObservations(db, createExtractOptions({ batchSize: 10 }));

      expect(mockLLMProvider.complete).toHaveBeenCalledTimes(3);
    });

    test('passes previous observations context to the next batch', async () => {
      let callCount = 0;
      (mockLLMProvider.complete as ReturnType<typeof mock>).mockImplementation?.(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: JSON.stringify([{ title: 'First batch signal', content: 'First batch content' }]),
            usage: { input_tokens: 100, output_tokens: 20 },
          };
        }
        return {
          text: JSON.stringify([{ title: 'Second batch result', content: 'Second batch content' }]),
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      });

      addReadEvents(db, TEST_SESSION_ID, 20);

      await extractObservations(db, createExtractOptions());

      expect(mockLLMProvider.complete).toHaveBeenCalledTimes(2);
    });
  });

  describe('archive', () => {
    test('archives JSONL when extraction completes', async () => {
      (mockLLMProvider.complete as ReturnType<typeof mock>).mockImplementation?.(async () => ({
        text: JSON.stringify([{ title: 'Test', content: 'Content' }]),
        usage: { input_tokens: 100, output_tokens: 20 },
      }));

      const sessionId = 'session-archive-test';
      const projectSlug = '-Users-jito-test-project';

      const srcProjectDir = path.join(tmpSrcDir, projectSlug);
      fs.mkdirSync(srcProjectDir, { recursive: true });
      fs.writeFileSync(path.join(srcProjectDir, `${sessionId}.jsonl`), '{"type":"user"}\n');

      recordEvent(db, sessionId, TEST_PROJECT, 'Read', { file_path: '/src/a.ts', lines: 10 });
      recordEvent(db, sessionId, TEST_PROJECT, 'Edit', { file_path: '/src/a.ts', old_string: 'a', new_string: 'b' });
      recordEvent(db, sessionId, TEST_PROJECT, 'Bash', { command: 'npm test', exitCode: 0 });

      await extractObservations(db, createExtractOptions({
        sessionId,
        project: TEST_PROJECT,
        projectSlug,
        claudeProjectsDir: tmpSrcDir,
        archiveDir: tmpDstDir,
      }));

      const archivedPath = path.join(tmpDstDir, projectSlug, `${sessionId}.jsonl`);
      expect(fs.existsSync(archivedPath)).toBe(true);
    });

    test('skips archive when fewer than 3 events', async () => {
      const sessionId = 'session-skip-archive';
      const projectSlug = '-Users-jito-test-project';

      const srcProjectDir = path.join(tmpSrcDir, projectSlug);
      fs.mkdirSync(srcProjectDir, { recursive: true });
      fs.writeFileSync(path.join(srcProjectDir, `${sessionId}.jsonl`), '{"type":"user"}\n');

      recordEvent(db, sessionId, TEST_PROJECT, 'Read', { file_path: '/src/a.ts', lines: 10 });
      recordEvent(db, sessionId, TEST_PROJECT, 'Read', { file_path: '/src/b.ts', lines: 10 });

      await extractObservations(db, createExtractOptions({
        sessionId,
        project: TEST_PROJECT,
        projectSlug,
        claudeProjectsDir: tmpSrcDir,
        archiveDir: tmpDstDir,
      }));

      const archivedPath = path.join(tmpDstDir, projectSlug, `${sessionId}.jsonl`);
      expect(fs.existsSync(archivedPath)).toBe(false);
    });
  });
});

describe('runExtract', () => {
  type MockDb = {
    close: ReturnType<typeof mock>;
  };

  type ExtractCliMockDeps = {
    openDatabase: ReturnType<typeof mock>;
    extractObservations: ReturnType<typeof mock>;
    loadConfig: ReturnType<typeof mock>;
    createProvider: ReturnType<typeof mock>;
  };

  function createDeps(overrides?: Partial<ExtractCliMockDeps>): ExtractCliDeps & ExtractCliMockDeps {
    const base: ExtractCliMockDeps = {
      openDatabase: mock(() => ({ close: mock(() => {}) })),
      extractObservations: mock(async () => {}),
      loadConfig: mock(() => null),
      createProvider: mock(async () => ({ complete: mock(async () => ({ text: '', usage: { input_tokens: 0, output_tokens: 0 } })) })),
    };
    return { ...base, ...overrides } as ExtractCliDeps & ExtractCliMockDeps;
  }

  test('calls extractObservations with correct args', async () => {
    const mockDb: MockDb = { close: mock(() => {}) };
    const mockConfig = { provider: 'gemini', apiKey: 'test-key', model: 'gemini-2.0-flash' };
    const mockProvider = { complete: mock(async () => ({ text: '', usage: { input_tokens: 0, output_tokens: 0 } })) };

    const deps = createDeps({
      openDatabase: mock(() => mockDb),
      loadConfig: mock(() => mockConfig),
      createProvider: mock(async () => mockProvider),
      extractObservations: mock(async () => undefined),
    });

    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      CLAUDE_SESSION_ID: 'env-session',
      CLAUDE_PROJECT: 'env-project',
      CLAUDE_PROJECT_DIR: '/Users/jito.hello/dev/wooto/memmem',
    };

    try {
      await runExtract(JSON.stringify({ session_id: 'stdin-session' }), deps);
    } finally {
      process.env = originalEnv;
    }

    expect(deps.loadConfig).toHaveBeenCalled();
    expect(deps.createProvider).toHaveBeenCalledWith(mockConfig);
    expect(deps.extractObservations).toHaveBeenCalledWith(mockDb, {
      provider: mockProvider,
      sessionId: 'stdin-session',
      project: 'env-project',
      projectSlug: '-Users-jito-hello-dev-wooto-memmem',
    });
    expect(mockDb.close).toHaveBeenCalled();
  });

  test('skips extraction when no config', async () => {
    const mockDb: MockDb = { close: mock(() => {}) };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const deps = createDeps({
      openDatabase: mock(() => mockDb),
      loadConfig: mock(() => null),
    });

    await runExtract(JSON.stringify({ session_id: 's1' }), deps);

    expect(errorSpy).toHaveBeenCalledWith('[memmem] No LLM config found, skipping observation extraction');
    expect(deps.createProvider).not.toHaveBeenCalled();
    expect(deps.extractObservations).not.toHaveBeenCalled();
    expect(mockDb.close).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  test('gets session_id from stdin JSON', async () => {
    const mockDb: MockDb = { close: mock(() => {}) };
    const mockConfig = { provider: 'gemini', apiKey: 'key', model: 'gemini-2.0-flash' };
    const mockProvider = { complete: mock(async () => ({ text: '', usage: { input_tokens: 0, output_tokens: 0 } })) };

    const deps = createDeps({
      openDatabase: mock(() => mockDb),
      loadConfig: mock(() => mockConfig),
      createProvider: mock(async () => mockProvider),
      extractObservations: mock(async () => undefined),
    });

    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      CLAUDE_SESSION_ID: 'env-fallback',
      CLAUDE_PROJECT: 'test-project',
      CLAUDE_PROJECT_DIR: undefined,
    };

    try {
      await runExtract(JSON.stringify({ session_id: 'from-stdin' }), deps);
    } finally {
      process.env = originalEnv;
    }

    expect(deps.extractObservations).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ sessionId: 'from-stdin' })
    );
  });

  test('handles empty stdin by falling back to env session', async () => {
    const mockDb: MockDb = { close: mock(() => {}) };
    const mockConfig = { provider: 'gemini', apiKey: 'key', model: 'gemini-2.0-flash' };
    const mockProvider = { complete: mock(async () => ({ text: '', usage: { input_tokens: 0, output_tokens: 0 } })) };

    const deps = createDeps({
      openDatabase: mock(() => mockDb),
      loadConfig: mock(() => mockConfig),
      createProvider: mock(async () => mockProvider),
      extractObservations: mock(async () => undefined),
    });

    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      CLAUDE_SESSION_ID: 'env-session',
      CLAUDE_PROJECT: 'env-project',
      CLAUDE_PROJECT_DIR: undefined,
    };

    try {
      await runExtract('   ', deps);
    } finally {
      process.env = originalEnv;
    }

    expect(deps.extractObservations).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ sessionId: 'env-session' })
    );
  });
});
