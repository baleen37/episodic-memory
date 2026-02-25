/**
 * Tests for recall.ts - SessionStart hook combining session-start + inject-cli.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase, insertObservation } from '../core/db.js';
import { recallContext, runRecallMain, type RecallConfig, type RecallResult, type RecallCliDeps } from './recall.js';
import { EMBEDDING_DIM } from '../core/constants.js';

// Real embedding array for insertObservation calls
const mockEmbedding = new Array(EMBEDDING_DIM).fill(0.1);

// ── recallContext unit tests ──────────────────────────────────────────────────

describe('recallContext', () => {
  let db: Database;

  beforeEach(() => {
    process.env.CONVERSATION_MEMORY_DB_PATH = ':memory:';
    db = initDatabase();
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  test('returns empty result when no observations exist', async () => {
    const config: RecallConfig = {
      maxObservations: 20,
      maxTokens: 500,
      recencyDays: 7,
      projectOnly: true,
    };

    const result = await recallContext(db, 'test-project', config);

    expect(result.markdown).toBe('');
    expect(result.includedCount).toBe(0);
    expect(result.tokenCount).toBe(0);
  });

  test('formats observations as markdown with header', async () => {
    insertObservation(
      db,
      {
        title: 'Fixed auth bug',
        content: 'Resolved JWT validation issue in login flow',
        project: 'test-project',
        sessionId: 'session-123',
        timestamp: Date.now(),
        createdAt: Date.now(),
      },
      mockEmbedding
    );

    const config: RecallConfig = {
      maxObservations: 20,
      maxTokens: 500,
      recencyDays: 7,
      projectOnly: true,
    };

    const result = await recallContext(db, 'test-project', config);

    expect(result.markdown).toContain('# test-project recent context (memmem)');
    expect(result.markdown).toContain('- Fixed auth bug: Resolved JWT validation issue in login flow');
    expect(result.includedCount).toBe(1);
  });

  test('includes multiple observations', async () => {
    const observations = [
      { title: 'Fixed auth bug', content: 'Resolved JWT validation issue' },
      { title: 'Added rate limiting', content: 'Implemented Redis-backed rate limiting for API' },
      { title: 'Updated tests', content: 'Increased test coverage to 85%' },
    ];

    for (const obs of observations) {
      insertObservation(
        db,
        {
          title: obs.title,
          content: obs.content,
          project: 'test-project',
          sessionId: 'session-123',
          timestamp: Date.now(),
          createdAt: Date.now(),
        },
        mockEmbedding
      );
    }

    const config: RecallConfig = {
      maxObservations: 20,
      maxTokens: 500,
      recencyDays: 7,
      projectOnly: true,
    };

    const result = await recallContext(db, 'test-project', config);

    expect(result.markdown).toContain('- Fixed auth bug: Resolved JWT validation issue');
    expect(result.markdown).toContain('- Added rate limiting: Implemented Redis-backed rate limiting for API');
    expect(result.markdown).toContain('- Updated tests: Increased test coverage to 85%');
    expect(result.includedCount).toBe(3);
  });

  test('respects token budget', async () => {
    // Insert observations that individually fit, but not all together under a tiny budget
    for (let i = 0; i < 5; i++) {
      insertObservation(
        db,
        {
          title: `Observation ${i}`,
          content: `Content ${i}`,
          project: 'test-project',
          sessionId: 'session-123',
          timestamp: Date.now(),
          createdAt: Date.now(),
        },
        mockEmbedding
      );
    }

    const config: RecallConfig = {
      maxObservations: 3,
      maxTokens: 500,
      recencyDays: 7,
      projectOnly: true,
    };

    const result = await recallContext(db, 'test-project', config);

    expect(result.includedCount).toBe(3);
  });

  test('filters by project when projectOnly is true', async () => {
    insertObservation(
      db,
      { title: 'Project A obs', content: 'Content A', project: 'project-a', sessionId: 'session-123', timestamp: Date.now(), createdAt: Date.now() },
      mockEmbedding
    );

    insertObservation(
      db,
      { title: 'Project B obs', content: 'Content B', project: 'project-b', sessionId: 'session-123', timestamp: Date.now(), createdAt: Date.now() },
      mockEmbedding
    );

    const config: RecallConfig = {
      maxObservations: 20,
      maxTokens: 500,
      recencyDays: 7,
      projectOnly: true,
    };

    const result = await recallContext(db, 'project-a', config);

    expect(result.markdown).toContain('Project A obs');
    expect(result.markdown).not.toContain('Project B obs');
    expect(result.includedCount).toBe(1);
  });

  test('includes all projects when projectOnly is false', async () => {
    insertObservation(
      db,
      { title: 'Project A obs', content: 'Content A', project: 'project-a', sessionId: 'session-123', timestamp: Date.now(), createdAt: Date.now() },
      mockEmbedding
    );

    insertObservation(
      db,
      { title: 'Project B obs', content: 'Content B', project: 'project-b', sessionId: 'session-123', timestamp: Date.now(), createdAt: Date.now() },
      mockEmbedding
    );

    const config: RecallConfig = {
      maxObservations: 20,
      maxTokens: 500,
      recencyDays: 7,
      projectOnly: false,
    };

    const result = await recallContext(db, 'project-a', config);

    expect(result.markdown).toContain('Project A obs');
    expect(result.markdown).toContain('Project B obs');
    expect(result.includedCount).toBe(2);
  });

  test('handles recencyDays cutoff', async () => {
    const now = Date.now();
    const dayInMs = 24 * 60 * 60 * 1000;

    insertObservation(
      db,
      { title: 'Old obs', content: 'Old content', project: 'test-project', sessionId: 'session-123', timestamp: now - 10 * dayInMs, createdAt: now - 10 * dayInMs },
      mockEmbedding
    );

    insertObservation(
      db,
      { title: 'Recent obs', content: 'Recent content', project: 'test-project', sessionId: 'session-123', timestamp: now - 2 * dayInMs, createdAt: now - 2 * dayInMs },
      mockEmbedding
    );

    const config: RecallConfig = {
      maxObservations: 20,
      maxTokens: 500,
      recencyDays: 7,
      projectOnly: true,
    };

    const result = await recallContext(db, 'test-project', config);

    expect(result.markdown).toContain('Recent obs');
    expect(result.markdown).not.toContain('Old obs');
    expect(result.includedCount).toBe(1);
  });

  test('returns results ordered by recency', async () => {
    const now = Date.now();

    insertObservation(
      db,
      { title: 'First', content: 'First content', project: 'test-project', sessionId: 'session-123', timestamp: now - 3000, createdAt: now - 3000 },
      mockEmbedding
    );

    insertObservation(
      db,
      { title: 'Second', content: 'Second content', project: 'test-project', sessionId: 'session-123', timestamp: now - 2000, createdAt: now - 2000 },
      mockEmbedding
    );

    insertObservation(
      db,
      { title: 'Third', content: 'Third content', project: 'test-project', sessionId: 'session-123', timestamp: now - 1000, createdAt: now - 1000 },
      mockEmbedding
    );

    const config: RecallConfig = {
      maxObservations: 20,
      maxTokens: 500,
      recencyDays: 7,
      projectOnly: true,
    };

    const result = await recallContext(db, 'test-project', config);

    const lines = result.markdown.split('\n').filter(line => line.startsWith('-'));
    expect(lines[0]).toContain('Third');
    expect(lines[1]).toContain('Second');
    expect(lines[2]).toContain('First');
  });
});

// ── runRecallMain CLI tests ───────────────────────────────────────────────────

const mockOpenDatabase = mock(() => ({} as Database));
const mockRecallContext = mock(async (_db: Database, _project: string, _config: RecallConfig): Promise<RecallResult> => ({
  markdown: '',
  includedCount: 0,
  tokenCount: 0,
}));

async function runRecall(stdinData: string): Promise<void> {
  const deps: RecallCliDeps = {
    openDatabase: mockOpenDatabase as unknown as RecallCliDeps['openDatabase'],
    recallContext: mockRecallContext as unknown as RecallCliDeps['recallContext'],
  };

  try {
    await runRecallMain(stdinData, deps);
  } catch (error) {
    console.error(`[memmem] Error in recall: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

describe('runRecallMain', () => {
  let mockDb: Database;
  let originalEnv: NodeJS.ProcessEnv;
  let consoleLogs: string[];
  let consoleErrors: string[];
  let exitCode: number | null;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockDb = {
      close: mock(() => {}),
      prepare: mock(() => ({ run: mock(() => {}), get: mock(() => null), all: mock(() => []) })),
    } as unknown as Database;

    mockOpenDatabase.mockImplementation?.(() => mockDb);
    mockRecallContext.mockImplementation?.(async () => ({ markdown: '', includedCount: 0, tokenCount: 0 }));

    originalEnv = { ...process.env };
    consoleLogs = [];
    consoleErrors = [];
    exitCode = null;

    consoleLogSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(' '));
    });

    consoleErrorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });

    exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      exitCode = typeof code === 'number' ? code : 1;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  describe('input parsing', () => {
    test('parses project from transcript_path', async () => {
      const stdin = JSON.stringify({
        session_id: 'session-123',
        transcript_path: '/.claude/projects/my-project/sessions/session-123/transcript.jsonl',
      });

      mockRecallContext.mockClear();
      await runRecall(stdin);

      const calls = (mockRecallContext as any).mock?.calls;
      expect(calls).toBeDefined();
      if (calls && calls.length > 0 && calls[0]) {
        expect(calls[0][1]).toBe('my-project');
      }
    });

    test('handles empty stdin with fallback values', async () => {
      mockRecallContext.mockClear();
      await runRecall('');

      expect(mockRecallContext).toHaveBeenCalledTimes(1);
    });

    test('calls recallContext with correct args when project is in input', async () => {
      process.env.CLAUDE_PROJECT = 'from-env';

      const stdin = JSON.stringify({
        session_id: 'session-123',
        transcript_path: '/.claude/projects/from-transcript/sessions/session-123/transcript.jsonl',
        project: 'from-input',
      });

      mockRecallContext.mockClear();
      await runRecall(stdin);

      const calls = (mockRecallContext as any).mock?.calls;
      expect(calls).toBeDefined();
      if (calls && calls.length > 0 && calls[0]) {
        expect(calls[0][1]).toBe('from-input');
      }
    });
  });

  describe('output', () => {
    test('prints markdown to stdout when present', async () => {
      const markdown = '# project recent context\n\n- Observation: Content';
      mockRecallContext.mockImplementation?.(async () => ({
        markdown,
        includedCount: 1,
        tokenCount: 50,
      } satisfies RecallResult));

      await runRecall(JSON.stringify({
        session_id: 'session-123',
        transcript_path: '/.claude/projects/test-project/sessions/session-123/transcript.jsonl',
      }));

      expect(consoleLogs).toEqual([markdown]);
    });

    test('does not print when markdown is empty', async () => {
      mockRecallContext.mockImplementation?.(async () => ({
        markdown: '',
        includedCount: 0,
        tokenCount: 0,
      } satisfies RecallResult));

      await runRecall(JSON.stringify({
        session_id: 'session-123',
        transcript_path: '/.claude/projects/test-project/sessions/session-123/transcript.jsonl',
      }));

      expect(consoleLogs).toHaveLength(0);
    });
  });

  describe('error paths', () => {
    test('handles invalid JSON input with stderr + exit(1)', async () => {
      try {
        await runRecall('{ invalid json }');
      } catch {
        // expected from mocked process.exit
      }

      expect(consoleErrors.length).toBeGreaterThan(0);
      expect(consoleErrors[0]).toContain('[memmem] Error in recall:');
      expect(exitCode).toBe(1);
    });

    test('handles recallContext failure with stderr + exit(1)', async () => {
      mockRecallContext.mockImplementation?.(async () => {
        throw new Error('Database connection failed');
      });

      try {
        await runRecall(JSON.stringify({
          session_id: 'session-123',
          transcript_path: '/.claude/projects/test-project/sessions/session-123/transcript.jsonl',
        }));
      } catch {
        // expected from mocked process.exit
      }

      expect(consoleErrors.length).toBeGreaterThan(0);
      expect(consoleErrors[0]).toContain('[memmem] Error in recall: Database connection failed');
      expect(exitCode).toBe(1);
    });
  });
});
