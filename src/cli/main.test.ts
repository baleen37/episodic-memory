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

  test('parses read args', () => {
    expect(parseReadArgs(['read', '/archive/session.jsonl', '--start-line', '3', '--end-line', '8'])).toEqual({
      path: '/archive/session.jsonl',
      startLine: 3,
      endLine: 8,
    });
  });
});
