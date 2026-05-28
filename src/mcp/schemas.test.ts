import { describe, expect, test } from 'bun:test';
import { SearchInputSchema, ReadInputSchema } from './schemas.js';

describe('MCP schemas', () => {
  test('validates transcript search input', () => {
    expect(SearchInputSchema.parse({ query: 'memory search', limit: 5, source_kind: 'claude-projects' })).toEqual({
      query: 'memory search',
      limit: 5,
      source_kind: 'claude-projects',
    });
  });

  test('validates read input', () => {
    expect(ReadInputSchema.parse({ path: '/archive/session.jsonl', startLine: 1, endLine: 3 })).toEqual({
      path: '/archive/session.jsonl',
      startLine: 1,
      endLine: 3,
    });
  });
});
