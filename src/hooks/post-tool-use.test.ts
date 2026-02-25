/**
 * Tests for PostToolUse hook that stores compressed tool events.
 *
 * This hook is responsible for:
 * 1. Getting compressed tool data using compress.ts
 * 2. Skipping tools that return null (low value)
 * 3. Storing in pending_events table
 * 4. Runs synchronously (simple function call)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { summarizeEvent } from '../core/summarize.js';
import { initDatabase, getAllBufferedEvents } from '../core/db.js';
import { handlePostToolUse } from './post-tool-use.js';

describe('PostToolUse Hook', () => {
  let db: Database;

  beforeEach(() => {
    // Use in-memory database for testing
    process.env.CONVERSATION_MEMORY_DB_PATH = ':memory:';
    db = initDatabase();
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  describe('handlePostToolUse', () => {
    test('stores compressed tool data in pending_events', () => {
      const toolData = {
        file_path: '/src/test.ts',
        lines: 100
      };

      handlePostToolUse(db, 'test-session-123', 'test-project', 'Read', toolData);

      const events = getAllBufferedEvents(db, 'test-session-123');
      expect(events).toHaveLength(1);
      expect(events[0].toolName).toBe('Read');
      expect(events[0].summary).toBe('Read /src/test.ts (100 lines)');
      expect(events[0].project).toBe('test-project');
      expect(events[0].sessionId).toBe('test-session-123');
    });

    test('skips tools that return null from compression', () => {
      const toolData = { pattern: 'test' };

      handlePostToolUse(db, 'test-session-123', 'test-project', 'Glob', toolData);

      const events = getAllBufferedEvents(db, 'test-session-123');
      expect(events).toHaveLength(0);
    });

    test('includes timestamp and createdAt fields', () => {
      const beforeTime = Date.now();
      const toolData = { command: 'echo test', exitCode: 0 };

      handlePostToolUse(db, 'test-session-123', 'test-project', 'Bash', toolData);

      const afterTime = Date.now();
      const events = getAllBufferedEvents(db, 'test-session-123');

      expect(events).toHaveLength(1);
      expect(events[0].timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(events[0].timestamp).toBeLessThanOrEqual(afterTime);
      expect(events[0].createdAt).toBeGreaterThanOrEqual(beforeTime);
      expect(events[0].createdAt).toBeLessThanOrEqual(afterTime);
    });

    test('handles Edit tool compression', () => {
      const toolData = {
        file_path: '/src/auth.ts',
        old_string: 'function login()',
        new_string: 'async function login()'
      };

      handlePostToolUse(db, 'test-session-123', 'test-project', 'Edit', toolData);

      const events = getAllBufferedEvents(db, 'test-session-123');
      expect(events).toHaveLength(1);
      expect(events[0].toolName).toBe('Edit');
      expect(events[0].summary).toContain('Edited /src/auth.ts:');
      expect(events[0].summary).toContain('function login()');
      expect(events[0].summary).toContain('→');
    });

    test('handles Write tool compression', () => {
      const toolData = {
        file_path: '/src/new.ts',
        lines: 250
      };

      handlePostToolUse(db, 'test-session-123', 'test-project', 'Write', toolData);

      const events = getAllBufferedEvents(db, 'test-session-123');
      expect(events).toHaveLength(1);
      expect(events[0].summary).toBe('Created /src/new.ts (250 lines)');
    });

    test('handles Bash tool compression with success', () => {
      const toolData = {
        command: 'npm test',
        exitCode: 0
      };

      handlePostToolUse(db, 'test-session-123', 'test-project', 'Bash', toolData);

      const events = getAllBufferedEvents(db, 'test-session-123');
      expect(events).toHaveLength(1);
      expect(events[0].summary).toContain('Ran `npm test` → exit 0');
    });

    test('handles Bash tool compression with error', () => {
      const toolData = {
        command: 'npm test',
        exitCode: 1,
        stderr: 'Error: Test failed\n    at test.js:10:5'
      };

      handlePostToolUse(db, 'test-session-123', 'test-project', 'Bash', toolData);

      const events = getAllBufferedEvents(db, 'test-session-123');
      expect(events).toHaveLength(1);
      expect(events[0].summary).toContain('Ran `npm test` → exit 1');
      expect(events[0].summary).toContain('Error: Test failed');
    });

    test('handles Grep tool compression', () => {
      const toolData = {
        pattern: 'TODO',
        path: '/src',
        count: 5
      };

      handlePostToolUse(db, 'test-session-123', 'test-project', 'Grep', toolData);

      const events = getAllBufferedEvents(db, 'test-session-123');
      expect(events).toHaveLength(1);
      expect(events[0].summary).toContain("Searched 'TODO' in /src → 5 matches");
    });

    test('handles WebSearch tool compression', () => {
      const toolData = {
        query: 'TypeScript best practices 2026'
      };

      handlePostToolUse(db, 'test-session-123', 'test-project', 'WebSearch', toolData);

      const events = getAllBufferedEvents(db, 'test-session-123');
      expect(events).toHaveLength(1);
      expect(events[0].summary).toBe('Searched: TypeScript best practices 2026');
    });

    test('handles WebFetch tool compression', () => {
      const toolData = {
        url: 'https://example.com/api/docs'
      };

      handlePostToolUse(db, 'test-session-123', 'test-project', 'WebFetch', toolData);

      const events = getAllBufferedEvents(db, 'test-session-123');
      expect(events).toHaveLength(1);
      expect(events[0].summary).toBe('Fetched https://example.com/api/docs');
    });

    test('handles multiple tool events in sequence', () => {
      handlePostToolUse(db, 'test-session-123', 'test-project', 'Read', { file_path: '/src/a.ts', lines: 10 });
      handlePostToolUse(db, 'test-session-123', 'test-project', 'Read', { file_path: '/src/b.ts', lines: 20 });
      handlePostToolUse(db, 'test-session-123', 'test-project', 'Bash', { command: 'echo test', exitCode: 0 });

      const events = getAllBufferedEvents(db, 'test-session-123');
      expect(events).toHaveLength(3);
      expect(events[0].summary).toContain('/src/a.ts');
      expect(events[1].summary).toContain('/src/b.ts');
      expect(events[2].summary).toContain('echo test');
    });

    test('filters out skipped tools', () => {
      // These tools should be skipped (return null from compress)
      const skippedTools = [
        'Glob', 'LSP', 'TodoWrite', 'TaskCreate', 'TaskUpdate',
        'TaskList', 'TaskGet', 'AskUserQuestion', 'EnterPlanMode',
        'ExitPlanMode', 'NotebookEdit', 'Skill'
      ];

      for (const toolName of skippedTools) {
        handlePostToolUse(db, 'test-session-123', 'test-project', toolName, {});
      }

      const events = getAllBufferedEvents(db, 'test-session-123');
      expect(events).toHaveLength(0);
    });

    test('handles different session IDs', () => {
      handlePostToolUse(db, 'session-1', 'project-1', 'Read', { file_path: '/a.ts', lines: 10 });
      handlePostToolUse(db, 'session-2', 'project-2', 'Read', { file_path: '/b.ts', lines: 20 });

      const events1 = getAllBufferedEvents(db, 'session-1');
      const events2 = getAllBufferedEvents(db, 'session-2');

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
      expect(events1[0].project).toBe('project-1');
      expect(events2[0].project).toBe('project-2');
    });

    test('handles unknown tool names', () => {
      handlePostToolUse(db, 'test-session-123', 'test-project', 'UnknownTool', { data: 'test' });

      const events = getAllBufferedEvents(db, 'test-session-123');
      expect(events).toHaveLength(1);
      expect(events[0].summary).toBe('UnknownTool');
    });

    test('compresses tool data correctly for all supported tools', () => {
      // Test the compression function directly
      expect(summarizeEvent('Read', { file_path: '/test.ts', lines: 100 }))
        .toBe('Read /test.ts (100 lines)');

      expect(summarizeEvent('Glob', { pattern: '*.ts' }))
        .toBeNull(); // Skipped

      expect(summarizeEvent('Edit', {
        file_path: '/test.ts',
        old_string: 'old',
        new_string: 'new'
      })).toContain('Edited /test.ts:');

      expect(summarizeEvent('Bash', {
        command: 'ls',
        exitCode: 0
      })).toBe('Ran `ls` → exit 0');
    });

    test('handles edge cases in compression', () => {
      // Empty file path
      expect(summarizeEvent('Read', {}))
        .toBe('Read');

      // Very long strings should be truncated
      const longString = 'a'.repeat(200);
      const result = summarizeEvent('Edit', {
        file_path: '/test.ts',
        old_string: longString,
        new_string: longString
      });
      expect(result).toContain('...');
      expect(result!.length).toBeLessThan(longString.length * 2);
    });
  });

  describe('Integration: pending_events table', () => {
    test('events can be retrieved after insertion', () => {
      const toolData = { file_path: '/test.ts', lines: 100 };

      handlePostToolUse(db, 'test-session-123', 'test-project', 'Read', toolData);

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

    test('multiple sessions do not interfere', () => {
      handlePostToolUse(db, 'session-1', 'project-1', 'Read', { file_path: '/a.ts', lines: 10 });
      handlePostToolUse(db, 'session-2', 'project-2', 'Read', { file_path: '/b.ts', lines: 20 });

      const events1 = getAllBufferedEvents(db, 'session-1');
      const events2 = getAllBufferedEvents(db, 'session-2');

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
      expect(events1[0].project).toBe('project-1');
      expect(events2[0].project).toBe('project-2');
    });
  });
});
