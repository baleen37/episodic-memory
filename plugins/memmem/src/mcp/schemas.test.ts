import { describe, expect, test } from 'bun:test';
import { SearchInputSchema, FetchInputSchema } from './schemas.js';

describe('MCP schemas', () => {
  test('validates memory search input', () => {
    expect(SearchInputSchema.parse({ query: 'memory search', limit: 5 })).toEqual({
      query: 'memory search',
      limit: 5,
    });
  });

  test('accepts input with no query for time-based recall', () => {
    expect(SearchInputSchema.parse({ after: '2026-06-16' })).toEqual({
      after: '2026-06-16',
      limit: 10,
    });
  });

  test('rejects unknown search filter keys', () => {
    expect(() => SearchInputSchema.parse({ query: 'memory search', source_kind: 'claude-code-projects' })).toThrow();
  });

  test('accepts array of 2-5 query strings', () => {
    expect(SearchInputSchema.parse({ query: ['alpha', 'beta'] })).toEqual({
      query: ['alpha', 'beta'],
      limit: 10,
    });
  });

  test('accepts array of 5 query strings', () => {
    expect(SearchInputSchema.parse({ query: ['a1', 'b2', 'c3', 'd4', 'e5'] })).toEqual({
      query: ['a1', 'b2', 'c3', 'd4', 'e5'],
      limit: 10,
    });
  });

  test('rejects array with fewer than 2 strings', () => {
    expect(() => SearchInputSchema.parse({ query: ['only-one'] })).toThrow();
  });

  test('rejects array with more than 5 strings', () => {
    expect(() => SearchInputSchema.parse({ query: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'] })).toThrow();
  });

  test('rejects array containing a too-short string', () => {
    expect(() => SearchInputSchema.parse({ query: ['ok', 'x'] })).toThrow();
  });

  test('validates fetch input with numeric id', () => {
    expect(FetchInputSchema.parse({ id: 42 })).toEqual({ id: 42 });
  });

  test('validates fetch input with string id', () => {
    expect(FetchInputSchema.parse({ id: '42' })).toEqual({ id: '42' });
  });
});
