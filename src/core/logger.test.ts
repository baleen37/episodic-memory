import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, utimesSync } from 'fs';
import { log } from './logger.js';

describe('logger', () => {
  let stderrSpy: ReturnType<typeof spyOn<typeof process.stderr, 'write'>>;
  let originalLevel: string | undefined;
  let originalConfigDir: string | undefined;
  let tempConfigDir: string;

  beforeEach(() => {
    originalLevel = process.env.MEMMEM_LOG_LEVEL;
    originalConfigDir = process.env.CONVERSATION_MEMORY_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), 'memmem-log-'));
    process.env.CONVERSATION_MEMORY_CONFIG_DIR = tempConfigDir;
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalLevel === undefined) {
      delete process.env.MEMMEM_LOG_LEVEL;
    } else {
      process.env.MEMMEM_LOG_LEVEL = originalLevel;
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
      delete process.env.MEMMEM_LOG_LEVEL;
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

  describe('MEMMEM_LOG_LEVEL=debug', () => {
    beforeEach(() => {
      process.env.MEMMEM_LOG_LEVEL = 'debug';
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

  describe('MEMMEM_LOG_LEVEL=silent', () => {
    beforeEach(() => {
      process.env.MEMMEM_LOG_LEVEL = 'silent';
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
      delete process.env.MEMMEM_LOG_LEVEL;
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
});
