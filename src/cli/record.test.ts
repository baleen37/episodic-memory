/**
 * Tests for record.ts: PostToolUse hook that summarizes and buffers tool events.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { summarizeEvent } from '../core/summarize.js';
import { initDatabase, getAllBufferedEvents } from '../core/db.js';
import { recordEvent, runRecord, type RecordCliDeps } from './record.js';

// ── recordEvent unit tests ────────────────────────────────────────────────────

describe('recordEvent', () => {
  let db: Database;

  beforeEach(() => {
    process.env.CONVERSATION_MEMORY_DB_PATH = ':memory:';
    db = initDatabase();
  });

  afterEach(() => {
    if (db) db.close();
  });

  test('stores summary in pending_events with correct fields', () => {
    const toolData = { file_path: '/src/test.ts', lines: 100 };

    recordEvent(db, 'test-session-123', 'test-project', 'Read', toolData);

    const events = getAllBufferedEvents(db, 'test-session-123');
    expect(events).toHaveLength(1);
    expect(events[0].toolName).toBe('Read');
    expect(events[0].summary).toBe('Read /src/test.ts (100 lines)');
    expect(events[0].project).toBe('test-project');
    expect(events[0].sessionId).toBe('test-session-123');
  });

  test('skips tools that return null from summarize (Glob)', () => {
    recordEvent(db, 'test-session-123', 'test-project', 'Glob', { pattern: 'test' });

    const events = getAllBufferedEvents(db, 'test-session-123');
    expect(events).toHaveLength(0);
  });

  test('includes timestamp and createdAt fields', () => {
    const beforeTime = Date.now();
    recordEvent(db, 'test-session-123', 'test-project', 'Bash', { command: 'echo test', exitCode: 0 });
    const afterTime = Date.now();

    const events = getAllBufferedEvents(db, 'test-session-123');
    expect(events).toHaveLength(1);
    expect(events[0].timestamp).toBeGreaterThanOrEqual(beforeTime);
    expect(events[0].timestamp).toBeLessThanOrEqual(afterTime);
    expect(events[0].createdAt).toBeGreaterThanOrEqual(beforeTime);
    expect(events[0].createdAt).toBeLessThanOrEqual(afterTime);
  });

  test('handles Edit tool summarization', () => {
    recordEvent(db, 'test-session-123', 'test-project', 'Edit', {
      file_path: '/src/auth.ts',
      old_string: 'function login()',
      new_string: 'async function login()',
    });

    const events = getAllBufferedEvents(db, 'test-session-123');
    expect(events).toHaveLength(1);
    expect(events[0].toolName).toBe('Edit');
    expect(events[0].summary).toContain('Edited /src/auth.ts:');
    expect(events[0].summary).toContain('function login()');
    expect(events[0].summary).toContain('→');
  });

  test('handles Write tool summarization', () => {
    recordEvent(db, 'test-session-123', 'test-project', 'Write', {
      file_path: '/src/new.ts',
      lines: 250,
    });

    const events = getAllBufferedEvents(db, 'test-session-123');
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Created /src/new.ts (250 lines)');
  });

  test('handles Bash tool with success', () => {
    recordEvent(db, 'test-session-123', 'test-project', 'Bash', { command: 'npm test', exitCode: 0 });

    const events = getAllBufferedEvents(db, 'test-session-123');
    expect(events).toHaveLength(1);
    expect(events[0].summary).toContain('Ran `npm test` → exit 0');
  });

  test('handles Bash tool with error', () => {
    recordEvent(db, 'test-session-123', 'test-project', 'Bash', {
      command: 'npm test',
      exitCode: 1,
      stderr: 'Error: Test failed\n    at test.js:10:5',
    });

    const events = getAllBufferedEvents(db, 'test-session-123');
    expect(events).toHaveLength(1);
    expect(events[0].summary).toContain('Ran `npm test` → exit 1');
    expect(events[0].summary).toContain('Error: Test failed');
  });

  test('handles Grep tool summarization', () => {
    recordEvent(db, 'test-session-123', 'test-project', 'Grep', {
      pattern: 'TODO',
      path: '/src',
      count: 5,
    });

    const events = getAllBufferedEvents(db, 'test-session-123');
    expect(events).toHaveLength(1);
    expect(events[0].summary).toContain("Searched 'TODO' in /src → 5 matches");
  });

  test('handles multiple tool events in sequence', () => {
    recordEvent(db, 'test-session-123', 'test-project', 'Read', { file_path: '/src/a.ts', lines: 10 });
    recordEvent(db, 'test-session-123', 'test-project', 'Read', { file_path: '/src/b.ts', lines: 20 });
    recordEvent(db, 'test-session-123', 'test-project', 'Bash', { command: 'echo test', exitCode: 0 });

    const events = getAllBufferedEvents(db, 'test-session-123');
    expect(events).toHaveLength(3);
    expect(events[0].summary).toContain('/src/a.ts');
    expect(events[1].summary).toContain('/src/b.ts');
    expect(events[2].summary).toContain('echo test');
  });

  test('filters out all skipped tools', () => {
    const skippedTools = [
      'Glob', 'LSP', 'TodoWrite', 'TaskCreate', 'TaskUpdate',
      'TaskList', 'TaskGet', 'AskUserQuestion', 'EnterPlanMode',
      'ExitPlanMode', 'NotebookEdit', 'Skill',
    ];

    for (const toolName of skippedTools) {
      recordEvent(db, 'test-session-123', 'test-project', toolName, {});
    }

    const events = getAllBufferedEvents(db, 'test-session-123');
    expect(events).toHaveLength(0);
  });

  test('handles multiple sessions independently', () => {
    recordEvent(db, 'session-1', 'project-1', 'Read', { file_path: '/a.ts', lines: 10 });
    recordEvent(db, 'session-2', 'project-2', 'Read', { file_path: '/b.ts', lines: 20 });

    const events1 = getAllBufferedEvents(db, 'session-1');
    const events2 = getAllBufferedEvents(db, 'session-2');

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
    expect(events1[0].project).toBe('project-1');
    expect(events2[0].project).toBe('project-2');
  });

  test('handles unknown tool names', () => {
    recordEvent(db, 'test-session-123', 'test-project', 'UnknownTool', { data: 'test' });

    const events = getAllBufferedEvents(db, 'test-session-123');
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('UnknownTool');
  });

  test('events have all required fields', () => {
    recordEvent(db, 'test-session-123', 'test-project', 'Read', { file_path: '/test.ts', lines: 100 });

    const events = getAllBufferedEvents(db, 'test-session-123');
    expect(events).toHaveLength(1);
    expect(events[0]).toHaveProperty('id');
    expect(events[0]).toHaveProperty('sessionId');
    expect(events[0]).toHaveProperty('project');
    expect(events[0]).toHaveProperty('toolName');
    expect(events[0]).toHaveProperty('summary');
    expect(events[0]).toHaveProperty('timestamp');
    expect(events[0]).toHaveProperty('createdAt');
  });

  test('summarizeEvent helper works correctly', () => {
    expect(summarizeEvent('Read', { file_path: '/test.ts', lines: 100 }))
      .toBe('Read /test.ts (100 lines)');
    expect(summarizeEvent('Glob', { pattern: '*.ts' }))
      .toBeNull();
    expect(summarizeEvent('Edit', { file_path: '/test.ts', old_string: 'old', new_string: 'new' }))
      .toContain('Edited /test.ts:');
    expect(summarizeEvent('Bash', { command: 'ls', exitCode: 0 }))
      .toBe('Ran `ls` → exit 0');
  });
});

// ── runRecord unit tests ──────────────────────────────────────────────────────

type MockDb = { close: ReturnType<typeof mock> };

function createDeps(overrides?: Partial<{ openDatabase: ReturnType<typeof mock>; recordEvent: ReturnType<typeof mock> }>): RecordCliDeps & { openDatabase: ReturnType<typeof mock>; recordEvent: ReturnType<typeof mock> } {
  const base = {
    openDatabase: mock(() => ({ close: mock(() => {}) })),
    recordEvent: mock(() => {}),
  };
  return { ...base, ...overrides };
}

describe('runRecord', () => {
  test('routes to recordEvent with correct parsed values', async () => {
    const mockDb: MockDb = { close: mock(() => {}) };
    const deps = createDeps({
      openDatabase: mock(() => mockDb),
    });

    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      CLAUDE_SESSION_ID: 'env-session',
      CLAUDE_PROJECT: 'env-project',
    };

    try {
      await runRecord(JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { exitCode: 0 },
        session_id: 'stdin-session',
      }), deps);
    } finally {
      process.env = originalEnv;
    }

    expect(deps.recordEvent).toHaveBeenCalledWith(
      mockDb,
      'stdin-session',
      'env-project',
      'Bash',
      { command: 'npm test', exitCode: 0 }
    );
    expect(mockDb.close).toHaveBeenCalled();
  });

  test('handles empty stdin (no-op)', async () => {
    const deps = createDeps();

    await runRecord('   \n\t  ', deps);

    expect(deps.openDatabase).not.toHaveBeenCalled();
    expect(deps.recordEvent).not.toHaveBeenCalled();
  });

  test('uses session_id from stdin JSON', async () => {
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
      await runRecord(JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: '/src/test.ts' },
        tool_response: { lines: 10 },
        session_id: 'stdin-session-id',
      }), deps);
    } finally {
      process.env = originalEnv;
    }

    expect(deps.recordEvent).toHaveBeenCalledWith(
      mockDb,
      'stdin-session-id',
      'test-project',
      'Read',
      { file_path: '/src/test.ts', lines: 10 }
    );
  });

  test('uses env fallback when stdin has no session_id', async () => {
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
      await runRecord(JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { exitCode: 0 },
      }), deps);
    } finally {
      process.env = originalEnv;
    }

    expect(deps.recordEvent).toHaveBeenCalledWith(
      mockDb,
      'fallback-session',
      'fallback-project',
      'Bash',
      { command: 'npm test', exitCode: 0 }
    );
    expect(mockDb.close).toHaveBeenCalled();
  });
});
