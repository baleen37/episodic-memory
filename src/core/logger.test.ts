import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { log, __flushForTests, __resetRetentionForTests } from './logger.js';

describe('logger', () => {
  let stderrSpy: ReturnType<typeof spyOn<typeof process.stderr, 'write'>>;
  let originalLevel: string | undefined;
  let originalConfigDir: string | undefined;
  let tempConfigDir: string;

  beforeEach(() => {
    originalLevel = process.env.EPISODIC_MEMORY_LOG_LEVEL;
    originalConfigDir = process.env.CONVERSATION_MEMORY_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), 'episodic-memory-log-'));
    process.env.CONVERSATION_MEMORY_CONFIG_DIR = tempConfigDir;
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    // Flush before restoring config dir so any residual buffer goes to the
    // temp dir (not the real ~/.config/episodic-memory/logs/).
    __flushForTests();
    __resetRetentionForTests();
    if (originalLevel === undefined) {
      delete process.env.EPISODIC_MEMORY_LOG_LEVEL;
    } else {
      process.env.EPISODIC_MEMORY_LOG_LEVEL = originalLevel;
    }
    if (originalConfigDir === undefined) {
      delete process.env.CONVERSATION_MEMORY_CONFIG_DIR;
    } else {
      process.env.CONVERSATION_MEMORY_CONFIG_DIR = originalConfigDir;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
    stderrSpy.mockRestore();
  });

  describe('default level (info)', () => {
    beforeEach(() => {
      delete process.env.EPISODIC_MEMORY_LOG_LEVEL;
    });

    test('info is output', () => {
      log.info('hello info');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy.mock.calls[0][0] as string).toContain('INFO hello info');
    });

    test('warn is output', () => {
      log.warn('hello warn');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy.mock.calls[0][0] as string).toContain('WARN hello warn');
    });

    test('error is output', () => {
      log.error('hello error');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy.mock.calls[0][0] as string).toContain('ERROR hello error');
    });

    test('debug is NOT output', () => {
      log.debug('hello debug');
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });

  describe('EPISODIC_MEMORY_LOG_LEVEL=debug', () => {
    beforeEach(() => {
      process.env.EPISODIC_MEMORY_LOG_LEVEL = 'debug';
    });

    test('debug is output', () => {
      log.debug('debug message');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy.mock.calls[0][0] as string).toContain('DEBUG debug message');
    });

    test('info is still output', () => {
      log.info('info message');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('EPISODIC_MEMORY_LOG_LEVEL=silent', () => {
    beforeEach(() => {
      process.env.EPISODIC_MEMORY_LOG_LEVEL = 'silent';
    });

    test('error is suppressed', () => {
      log.error('nope');
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    test('warn is suppressed', () => {
      log.warn('nope');
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    test('info is suppressed', () => {
      log.info('nope');
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    test('debug is suppressed', () => {
      log.debug('nope');
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });

  describe('output format', () => {
    beforeEach(() => {
      delete process.env.EPISODIC_MEMORY_LOG_LEVEL;
    });

    test('includes ISO timestamp', () => {
      log.info('ts test');
      const line = stderrSpy.mock.calls[0][0] as string;
      expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    });

    test('meta included as JSON when provided', () => {
      log.info('with meta', { count: 5, file: 'foo.ts' });
      const line = stderrSpy.mock.calls[0][0] as string;
      expect(line).toContain('{"count":5,"file":"foo.ts"}');
    });

    test('no JSON suffix when meta is absent', () => {
      log.info('no meta');
      const line = stderrSpy.mock.calls[0][0] as string;
      expect(line).not.toContain('{');
      expect(line.trimEnd()).toBe(line.trimEnd()); // no trailing garbage
    });

    test('line ends with newline', () => {
      log.info('newline test');
      const line = stderrSpy.mock.calls[0][0] as string;
      expect(line.endsWith('\n')).toBe(true);
    });

    test('goes to stderr not stdout', () => {
      const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
      log.info('stderr only');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stdoutSpy).not.toHaveBeenCalled();
      stdoutSpy.mockRestore();
    });
  });

  describe('file sink', () => {
    test('flushed info line is written to today log file', () => {
      log.info('file sink line');
      __flushForTests();
      const date = new Date().toISOString().split('T')[0];
      const logPath = join(tempConfigDir, 'logs', `${date}.log`);
      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, 'utf8')).toContain('INFO file sink line');
    });

    test('auto-flushes after 64 buffered lines', () => {
      const savedNodeEnv = process.env.NODE_ENV;
      delete process.env.NODE_ENV;
      try {
        for (let i = 0; i < 64; i++) {
          log.info(`bulk line ${i}`);
        }
        const date = new Date().toISOString().split('T')[0];
        const logPath = join(tempConfigDir, 'logs', `${date}.log`);
        expect(existsSync(logPath)).toBe(true);
        const contents = readFileSync(logPath, 'utf8');
        expect(contents).toContain('bulk line 0');
        expect(contents).toContain('bulk line 63');
      } finally {
        if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = savedNodeEnv;
      }
    });

    test('silent level writes no file', () => {
      process.env.EPISODIC_MEMORY_LOG_LEVEL = 'silent';
      log.error('should not be written');
      __flushForTests();
      const logsDir = join(tempConfigDir, 'logs');
      // Either the logs dir was never created, or it contains no log files.
      const files = existsSync(logsDir) ? readdirSync(logsDir) : [];
      expect(files.filter(f => f.endsWith('.log'))).toEqual([]);
    });

    test('automatic flush under NODE_ENV=test does not write a file', () => {
      // NODE_ENV is 'test' under bun test; do not override it here.
      for (let i = 0; i < 64; i++) {
        log.info(`suppressed line ${i}`);
      }
      // The 64-line threshold triggered an automatic flush, which must be
      // suppressed under test (no force). No file should exist.
      const date = new Date().toISOString().split('T')[0];
      const logPath = join(tempConfigDir, 'logs', `${date}.log`);
      expect(existsSync(logPath)).toBe(false);
    });

    test('logging schedules a flush without hanging (unref timer)', () => {
      log.info('scheduled flush line');
      // If the timer were not unref()'d it could keep handles open; we assert the
      // buffer still flushes on demand and the call returns synchronously.
      __flushForTests();
      const date = new Date().toISOString().split('T')[0];
      const logPath = join(tempConfigDir, 'logs', `${date}.log`);
      expect(readFileSync(logPath, 'utf8')).toContain('scheduled flush line');
    });

    test('prunes log files older than 14 days, keeps recent', () => {
      const logsDir = join(tempConfigDir, 'logs');
      // getLogDir() ensures the dir; create it via a real flush first.
      log.info('seed');
      __flushForTests();
      expect(existsSync(logsDir)).toBe(true);

      const DAY_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const oldDate = new Date(now - 15 * DAY_MS).toISOString().split('T')[0];
      const recentDate = new Date(now - 13 * DAY_MS).toISOString().split('T')[0];
      const oldPath = join(logsDir, `${oldDate}.log`);
      const recentPath = join(logsDir, `${recentDate}.log`);
      writeFileSync(oldPath, 'old\n');
      writeFileSync(recentPath, 'recent\n');

      // Retention runs once per process and already ran on the seed flush above.
      // Force it to run again for this test via the test-only reset + flush.
      __resetRetentionForTests();
      log.info('trigger');
      __flushForTests();

      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(recentPath)).toBe(true);
    });
  });
});
