import { describe, expect, test } from 'bun:test';
import { parseSearchArgs, parseReadArgs } from './main.js';

describe('CLI argument parsing', () => {
  test('parses search args', () => {
    expect(parseSearchArgs(['search', 'semantic memory', '--after', '2026-05-01', '--source-kind', 'codex-sessions', '--limit', '5'])).toEqual({
      query: 'semantic memory',
      after: '2026-05-01',
      before: undefined,
      sourceKind: 'codex-sessions',
      limit: 5,
    });
  });

  test('parses multi-token search query', () => {
    expect(parseSearchArgs(['search', 'semantic', 'memory', '--limit', '5'])).toEqual({
      query: 'semantic memory',
      after: undefined,
      before: undefined,
      sourceKind: undefined,
      limit: 5,
    });
  });

  test('rejects invalid numeric search option', () => {
    expect(() => parseSearchArgs(['search', 'semantic memory', '--limit', '0'])).toThrow('--limit must be a positive integer');
  });

  test('rejects missing search option value', () => {
    expect(() => parseSearchArgs(['search', 'semantic memory', '--after'])).toThrow('--after requires a value');
  });

  test('rejects empty search query', () => {
    expect(() => parseSearchArgs(['search', '--limit', '5'])).toThrow('search requires a query');
  });

  test('parses read args', () => {
    expect(parseReadArgs(['read', '/archive/session.jsonl', '--start-line', '3', '--end-line', '8'])).toEqual({
      path: '/archive/session.jsonl',
      startLine: 3,
      endLine: 8,
    });
  });

  test('rejects missing read path', () => {
    expect(() => parseReadArgs(['read'])).toThrow('read requires a path');
  });

  test('rejects flag as read path', () => {
    expect(() => parseReadArgs(['read', '--start-line', '3'])).toThrow('read requires a path');
  });

  test('rejects invalid numeric read option', () => {
    expect(() => parseReadArgs(['read', '/archive/session.jsonl', '--start-line', '0'])).toThrow('--start-line must be a positive integer');
  });

  test('rejects start line after end line', () => {
    expect(() => parseReadArgs(['read', '/archive/session.jsonl', '--start-line', '9', '--end-line', '8'])).toThrow('--start-line must be less than or equal to --end-line');
  });
});
