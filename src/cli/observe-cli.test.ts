import { describe, test, expect, mock, spyOn } from 'bun:test';
import { runObserve, runSummarize, runWithStdinData, type ObserveCliDeps } from './observe-cli.js';

type MockDb = {
  close: ReturnType<typeof mock>;
};

type ObserveCliMockDeps = {
  openDatabase: ReturnType<typeof mock>;
  handlePostToolUse: ReturnType<typeof mock>;
  handleStop: ReturnType<typeof mock>;
  loadConfig: ReturnType<typeof mock>;
  createProvider: ReturnType<typeof mock>;
};

function createDeps(overrides?: Partial<ObserveCliMockDeps>): ObserveCliDeps & ObserveCliMockDeps {
  const base: ObserveCliMockDeps = {
    openDatabase: mock(() => ({ close: mock(() => {}) })),
    handlePostToolUse: mock(() => {}),
    handleStop: mock(async () => {}),
    loadConfig: mock(() => null),
    createProvider: mock(async () => ({ complete: mock(async () => ({ text: '', usage: { input_tokens: 0, output_tokens: 0 } })) })),
  };

  return {
    ...base,
    ...overrides,
  } as ObserveCliDeps & ObserveCliMockDeps;
}

describe('observe-cli behavior', () => {
  test('routes summarize flow and calls handleStop with derived values', async () => {
    const mockDb: MockDb = { close: mock(() => {}) };
    const mockConfig = { provider: 'gemini', apiKey: 'test-key', model: 'gemini-2.0-flash' };
    const mockProvider = { complete: mock(async () => ({ text: '', usage: { input_tokens: 0, output_tokens: 0 } })) };

    const deps = createDeps({
      openDatabase: mock(() => mockDb),
      loadConfig: mock(() => mockConfig),
      createProvider: mock(async () => mockProvider),
      handleStop: mock(async () => undefined),
    });

    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      CLAUDE_SESSION_ID: 'env-session',
      CLAUDE_PROJECT: 'env-project',
      CLAUDE_PROJECT_DIR: '/Users/jito.hello/dev/wooto/memmem',
    };

    try {
      await runSummarize('stdin-session', deps);
    } finally {
      process.env = originalEnv;
    }

    expect(deps.loadConfig).toHaveBeenCalled();
    expect(deps.createProvider).toHaveBeenCalledWith(mockConfig);
    expect(deps.handleStop).toHaveBeenCalledWith(mockDb, {
      provider: mockProvider,
      sessionId: 'stdin-session',
      project: 'env-project',
      projectSlug: '-Users-jito-hello-dev-wooto-memmem',
    });
    expect(deps.handlePostToolUse).not.toHaveBeenCalled();
    expect(mockDb.close).toHaveBeenCalled();
  });

  test('calls handlePostToolUse with merged payload and env fallback values', async () => {
    const mockDb: MockDb = { close: mock(() => {}) };
    const deps = createDeps({
      openDatabase: mock(() => mockDb),
    });

    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      CLAUDE_SESSION_ID: undefined,
      CLAUDE_SESSION: 'fallback-session',
      CLAUDE_PROJECT: undefined,
      CLAUDE_PROJECT_NAME: 'fallback-project',
    };

    try {
      await runObserve('Bash', { command: 'npm test' }, { exitCode: 0 }, undefined, deps);
    } finally {
      process.env = originalEnv;
    }

    expect(deps.handlePostToolUse).toHaveBeenCalledWith(
      mockDb,
      'fallback-session',
      'fallback-project',
      'Bash',
      { command: 'npm test', exitCode: 0 }
    );
    expect(deps.handleStop).not.toHaveBeenCalled();
    expect(mockDb.close).toHaveBeenCalled();
  });

  test('prefers stdin session_id over env session for PostToolUse', async () => {
    const mockDb: MockDb = { close: mock(() => {}) };
    const deps = createDeps({
      openDatabase: mock(() => mockDb),
    });

    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      CLAUDE_SESSION_ID: 'env-session-id',
      CLAUDE_PROJECT: 'test-project',
    };

    try {
      await runObserve('Read', { file_path: '/src/test.ts' }, { lines: 10 }, 'stdin-session-id', deps);
    } finally {
      process.env = originalEnv;
    }

    expect(deps.handlePostToolUse).toHaveBeenCalledWith(
      mockDb,
      'stdin-session-id',
      'test-project',
      'Read',
      { file_path: '/src/test.ts', lines: 10 }
    );
  });

  test('returns early for empty stdin in non-summarize path', async () => {
    const deps = createDeps();

    await runWithStdinData('   \n\t  ', false, deps);

    expect(deps.openDatabase).not.toHaveBeenCalled();
    expect(deps.handlePostToolUse).not.toHaveBeenCalled();
    expect(deps.handleStop).not.toHaveBeenCalled();
  });

  test('logs skip message when summarize config is missing', async () => {
    const mockDb: MockDb = { close: mock(() => {}) };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const deps = createDeps({
      openDatabase: mock(() => mockDb),
      loadConfig: mock(() => null),
    });

    await runSummarize('s1', deps);

    expect(errorSpy).toHaveBeenCalledWith('[memmem] No LLM config found, skipping observation extraction');
    expect(deps.createProvider).not.toHaveBeenCalled();
    expect(deps.handleStop).not.toHaveBeenCalled();
    expect(mockDb.close).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  test('logs error and exits 0 on invalid stdin JSON', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      await runWithStdinData('{ invalid json }', false, createDeps());
    } catch (error) {
      console.error(`[memmem] Error in observe: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(0);
    }

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[memmem] Error in observe:'));
    expect(exitSpy).toHaveBeenCalledWith(0);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
