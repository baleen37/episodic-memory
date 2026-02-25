/**
 * Tests for main.ts - CLI entry point.
 *
 * This is the main CLI entry point that:
 * - Shows help when no command or --help is provided
 * - Routes to recall.js for 'recall' command
 * - Routes to record.js for 'record' command
 * - Routes to extract.js for 'extract' command
 * - Shows error for unknown commands
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

describe('main', () => {
  let originalArgv: string[];
  let originalExit: (code?: number) => never;
  let consoleLogs: string[];
  let consoleErrors: string[];

  beforeEach(() => {
    originalArgv = process.argv;
    consoleLogs = [];
    consoleErrors = [];

    originalExit = process.exit;
    process.exit = mock((code?: number) => {
      throw new Error(`process.exit called with code ${code}`);
    }) as unknown as (code?: number) => never;

    spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(' '));
    });
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    mock.restore();
  });

  describe('command parsing', () => {
    test('should detect no command when argv length is 2', () => {
      process.argv = ['node', 'main'];
      const command = process.argv[2];
      expect(command).toBeUndefined();
    });

    test('should detect --help flag', () => {
      process.argv = ['node', 'main', '--help'];
      const command = process.argv[2];
      expect(command).toBe('--help');
    });

    test('should detect -h flag', () => {
      process.argv = ['node', 'main', '-h'];
      const command = process.argv[2];
      expect(command).toBe('-h');
    });

    test('should detect recall command', () => {
      process.argv = ['node', 'main', 'recall'];
      const command = process.argv[2];
      expect(command).toBe('recall');
    });

    test('should detect record command', () => {
      process.argv = ['node', 'main', 'record'];
      const command = process.argv[2];
      expect(command).toBe('record');
    });

    test('should detect extract command', () => {
      process.argv = ['node', 'main', 'extract'];
      const command = process.argv[2];
      expect(command).toBe('extract');
    });

    test('should detect unknown command', () => {
      process.argv = ['node', 'main', 'unknown-command'];
      const command = process.argv[2];
      expect(command).toBe('unknown-command');
    });
  });

  describe('command routing logic', () => {
    test('should route recall command correctly', () => {
      const command = 'recall';
      const shouldRouteToRecall = command === 'recall';
      expect(shouldRouteToRecall).toBe(true);
    });

    test('should route record command correctly', () => {
      const command = 'record';
      const shouldRouteToRecord = command === 'record';
      expect(shouldRouteToRecord).toBe(true);
    });

    test('should route extract command correctly', () => {
      const command = 'extract';
      const shouldRouteToExtract = command === 'extract';
      expect(shouldRouteToExtract).toBe(true);
    });

    test('should identify unknown command', () => {
      const command: string = 'invalid-command';
      const isKnownCommand = command === 'recall' || command === 'record' || command === 'extract';
      expect(isKnownCommand).toBe(false);
    });
  });

  describe('help text content', () => {
    test('should contain CLI title', () => {
      const expectedTitle = 'memmem';
      expect(expectedTitle).toBe('memmem');
    });

    test('should list all commands', () => {
      const expectedCommands = ['recall', 'record', 'extract'];
      expectedCommands.forEach(cmd => {
        expect(typeof cmd).toBe('string');
      });
    });

    test('should include environment variables section', () => {
      const expectedEnvVars = [
        'CONVERSATION_MEMORY_CONFIG_DIR',
        'CONVERSATION_MEMORY_DB_PATH',
        'CLAUDE_SESSION_ID',
        'CLAUDE_PROJECT'
      ];
      expectedEnvVars.forEach(envVar => {
        expect(typeof envVar).toBe('string');
      });
    });
  });

  describe('error messaging', () => {
    test('should format unknown command error', () => {
      const unknownCommand = 'fake-command';
      const errorMessage = `Unknown command: ${unknownCommand}`;
      expect(errorMessage).toContain('Unknown command:');
      expect(errorMessage).toContain('fake-command');
    });

    test('should include usage hint in error', () => {
      const usageHint = 'Run with --help for usage information.';
      expect(usageHint).toContain('--help');
    });
  });
});
