import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from 'bun:sqlite';

vi.mock('../core/db.js', () => ({
  openDatabase: vi.fn(),
}));

vi.mock('../hooks/session-start.js', () => ({
  handleSessionStart: vi.fn(),
}));

import { openDatabase } from '../core/db.js';
import { handleSessionStart } from '../hooks/session-start.js';
import type { SessionStartConfig, SessionStartResult } from '../hooks/session-start.js';

interface SessionStartInput {
  session_id: string;
  transcript_path: string;
  project?: string;
}

function parseInput(stdinData: string): SessionStartInput {
  if (stdinData.trim()) {
    return JSON.parse(stdinData) as SessionStartInput;
  }

  return {
    session_id: process.env.CLAUDE_SESSION_ID || 'unknown',
    transcript_path: '',
  };
}

function resolveProject(input: SessionStartInput): string {
  if (input.project) {
    return input.project;
  }

  const match = input.transcript_path.match(/\/projects\/([^\/]+)\//);
  if (match && match[1]) {
    return match[1];
  }

  return process.env.CLAUDE_PROJECT || 'default';
}

function getConfig(): SessionStartConfig {
  return {
    maxObservations: parseInt(process.env.CONVERSATION_MEMORY_MAX_OBSERVATIONS || '10', 10),
    maxTokens: parseInt(process.env.CONVERSATION_MEMORY_MAX_TOKENS || '1000', 10),
    recencyDays: parseInt(process.env.CONVERSATION_MEMORY_RECENCY_DAYS || '7', 10),
    projectOnly: process.env.CONVERSATION_MEMORY_PROJECT_ONLY === 'true',
  };
}

async function runInject(stdinData: string): Promise<void> {
  try {
    const input = parseInput(stdinData);
    const project = resolveProject(input);
    const config = getConfig();

    const db = openDatabase();

    try {
      const result = await handleSessionStart(db, project, config);

      if (result.markdown) {
        console.log(result.markdown);
      }
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(`[memmem] Error in inject: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

describe('inject-cli behavior', () => {
  let mockDb: Database;
  let originalEnv: NodeJS.ProcessEnv;
  let consoleLogs: string[];
  let consoleErrors: string[];
  let exitCode: number | null;

  beforeEach(() => {
    mockDb = {
      close: vi.fn(),
      prepare: vi.fn().mockReturnThis(),
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn(),
    } as unknown as Database;

    (openDatabase as ReturnType<typeof vi.fn>).mockReturnValue(mockDb);

    originalEnv = { ...process.env };
    consoleLogs = [];
    consoleErrors = [];
    exitCode = null;

    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(' '));
    });

    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });

    vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      exitCode = typeof code === 'number' ? code : 1;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);

    vi.clearAllMocks();
    (openDatabase as ReturnType<typeof vi.fn>).mockReturnValue(mockDb);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('input parsing', () => {
    test('parses JSON stdin and passes project/session data into flow', async () => {
      const stdin = JSON.stringify({
        session_id: 'session-123',
        transcript_path: '/.claude/projects/my-project/sessions/session-123/transcript.jsonl',
      });

      const mockResult: SessionStartResult = {
        markdown: '',
        includedCount: 0,
        tokenCount: 0,
      };
      (handleSessionStart as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      await runInject(stdin);

      expect(handleSessionStart).toHaveBeenCalledTimes(1);
      expect((handleSessionStart as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('my-project');
      expect(mockDb.close).toHaveBeenCalledTimes(1);
    });

    test('uses default input when stdin is empty and resolves session from env', async () => {
      process.env.CLAUDE_SESSION_ID = 'env-session';
      process.env.CLAUDE_PROJECT = 'env-project';

      const mockResult: SessionStartResult = {
        markdown: '',
        includedCount: 0,
        tokenCount: 0,
      };
      (handleSessionStart as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      await runInject('');

      expect(handleSessionStart).toHaveBeenCalledTimes(1);
      expect((handleSessionStart as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('env-project');
    });
  });

  describe('project resolution priority', () => {
    test('prefers input.project over transcript path and env', async () => {
      process.env.CLAUDE_PROJECT = 'from-env';

      const stdin = JSON.stringify({
        session_id: 'session-123',
        transcript_path: '/.claude/projects/from-transcript/sessions/session-123/transcript.jsonl',
        project: 'from-input',
      });

      const mockResult: SessionStartResult = {
        markdown: '',
        includedCount: 0,
        tokenCount: 0,
      };
      (handleSessionStart as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      await runInject(stdin);

      expect((handleSessionStart as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('from-input');
    });

    test('falls back to transcript path, then env, then default', async () => {
      (handleSessionStart as ReturnType<typeof vi.fn>).mockResolvedValue({
        markdown: '',
        includedCount: 0,
        tokenCount: 0,
      } satisfies SessionStartResult);

      await runInject(JSON.stringify({
        session_id: 'session-1',
        transcript_path: '/.claude/projects/from-transcript/sessions/session-1/transcript.jsonl',
      }));
      expect((handleSessionStart as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('from-transcript');

      process.env.CLAUDE_PROJECT = 'from-env';
      await runInject(JSON.stringify({
        session_id: 'session-2',
        transcript_path: '/no/project/in/path',
      }));
      expect((handleSessionStart as ReturnType<typeof vi.fn>).mock.calls[1][1]).toBe('from-env');

      delete process.env.CLAUDE_PROJECT;
      await runInject(JSON.stringify({
        session_id: 'session-3',
        transcript_path: '/still/no/project',
      }));
      expect((handleSessionStart as ReturnType<typeof vi.fn>).mock.calls[2][1]).toBe('default');
    });
  });

  describe('output payload', () => {
    test('prints markdown payload to stdout when present', async () => {
      const markdown = '# project recent context\n\n- Observation: Content';
      (handleSessionStart as ReturnType<typeof vi.fn>).mockResolvedValue({
        markdown,
        includedCount: 1,
        tokenCount: 50,
      } satisfies SessionStartResult);

      await runInject(JSON.stringify({
        session_id: 'session-123',
        transcript_path: '/.claude/projects/test-project/sessions/session-123/transcript.jsonl',
      }));

      expect(consoleLogs).toEqual([markdown]);
    });

    test('does not print when markdown is empty', async () => {
      (handleSessionStart as ReturnType<typeof vi.fn>).mockResolvedValue({
        markdown: '',
        includedCount: 0,
        tokenCount: 0,
      } satisfies SessionStartResult);

      await runInject(JSON.stringify({
        session_id: 'session-123',
        transcript_path: '/.claude/projects/test-project/sessions/session-123/transcript.jsonl',
      }));

      expect(consoleLogs).toHaveLength(0);
    });
  });

  describe('error paths', () => {
    test('handles invalid JSON input with stderr + exit(1)', async () => {
      await expect(runInject('{ invalid json }')).rejects.toThrow('process.exit(1)');

      expect(consoleErrors.length).toBeGreaterThan(0);
      expect(consoleErrors[0]).toContain('[memmem] Error in inject:');
      expect(exitCode).toBe(1);
    });

    test('handles handleSessionStart failure with stderr + exit(1) and closes db', async () => {
      (handleSessionStart as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Database connection failed'));

      await expect(
        runInject(JSON.stringify({
          session_id: 'session-123',
          transcript_path: '/.claude/projects/test-project/sessions/session-123/transcript.jsonl',
        }))
      ).rejects.toThrow('process.exit(1)');

      expect(consoleErrors.length).toBeGreaterThan(0);
      expect(consoleErrors[0]).toContain('[memmem] Error in inject: Database connection failed');
      expect(mockDb.close).toHaveBeenCalledTimes(1);
      expect(exitCode).toBe(1);
    });
  });
});
