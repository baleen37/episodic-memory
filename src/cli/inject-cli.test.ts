import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runInjectMain, type InjectCliDeps } from './inject-cli.js';
import type { SessionStartConfig, SessionStartResult } from '../hooks/session-start.js';

// Create mock functions with explicit types
const mockOpenDatabase = mock(() => ({} as Database));
const mockHandleSessionStart = mock(async (_db: Database, _project: string, _config: SessionStartConfig): Promise<SessionStartResult> => ({
  markdown: '',
  includedCount: 0,
  tokenCount: 0
}));

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
  const deps: InjectCliDeps = {
    openDatabase: mockOpenDatabase as unknown as InjectCliDeps['openDatabase'],
    handleSessionStart: mockHandleSessionStart as unknown as InjectCliDeps['handleSessionStart'],
  };

  try {
    await runInjectMain(stdinData, deps);
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
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockDb = {
      close: mock(() => {}),
      prepare: mock(() => ({ run: mock(() => {}), get: mock(() => null), all: mock(() => []) })),
    } as unknown as Database;

    mockOpenDatabase.mockImplementation?.(() => mockDb);
    mockHandleSessionStart.mockImplementation?.(async () => ({ markdown: '', includedCount: 0, tokenCount: 0 }));

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
      mockHandleSessionStart.mockImplementation?.(async () => mockResult);

      await runInject(stdin);

      expect(mockHandleSessionStart).toHaveBeenCalledTimes(1);
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
      mockHandleSessionStart.mockImplementation?.(async () => mockResult);
      mockHandleSessionStart.mockClear();

      await runInject(stdin);

      const calls = (mockHandleSessionStart as any).mock?.calls;
      expect(calls).toBeDefined();
      if (calls && calls.length > 0 && calls[0]) {
        expect(calls[0][1]).toBe('from-input');
      }
    });
  });

  describe('output payload', () => {
    test('prints markdown payload to stdout when present', async () => {
      const markdown = '# project recent context\n\n- Observation: Content';
      mockHandleSessionStart.mockImplementation?.(async () => ({
        markdown,
        includedCount: 1,
        tokenCount: 50,
      } satisfies SessionStartResult));

      await runInject(JSON.stringify({
        session_id: 'session-123',
        transcript_path: '/.claude/projects/test-project/sessions/session-123/transcript.jsonl',
      }));

      expect(consoleLogs).toEqual([markdown]);
    });

    test('does not print when markdown is empty', async () => {
      mockHandleSessionStart.mockImplementation?.(async () => ({
        markdown: '',
        includedCount: 0,
        tokenCount: 0,
      } satisfies SessionStartResult));

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

    test('handles handleSessionStart failure with stderr + exit(1)', async () => {
      mockHandleSessionStart.mockImplementation?.(async () => {
        throw new Error('Database connection failed');
      });

      await expect(
        runInject(JSON.stringify({
          session_id: 'session-123',
          transcript_path: '/.claude/projects/test-project/sessions/session-123/transcript.jsonl',
        }))
      ).rejects.toThrow('process.exit(1)');

      expect(consoleErrors.length).toBeGreaterThan(0);
      expect(consoleErrors[0]).toContain('[memmem] Error in inject: Database connection failed');
      expect(exitCode).toBe(1);
    });
  });
});
