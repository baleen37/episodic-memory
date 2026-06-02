import { describe, expect, test } from 'bun:test';
import { SearchInputSchema, FetchInputSchema } from './schemas.js';

describe('MCP schemas', () => {
  test('validates memory search input', () => {
    expect(SearchInputSchema.parse({ query: 'memory search', limit: 5 })).toEqual({
      query: 'memory search',
      limit: 5,
    });
  });

  test('rejects unknown search filter keys', () => {
    expect(() => SearchInputSchema.parse({ query: 'memory search', source_kind: 'claude-projects' })).toThrow();
  });

  test('validates fetch input with numeric id', () => {
    expect(FetchInputSchema.parse({ id: 42 })).toEqual({ id: 42 });
  });

  test('validates fetch input with string id', () => {
    expect(FetchInputSchema.parse({ id: '42' })).toEqual({ id: '42' });
  });
});
