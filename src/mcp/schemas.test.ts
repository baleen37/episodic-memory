import { describe, expect, test } from 'bun:test';
import { SearchInputSchema } from './schemas.js';

describe('MCP schemas', () => {
  test('validates memory search input', () => {
    expect(SearchInputSchema.parse({ query: 'memory search', limit: 5 })).toEqual({
      query: 'memory search',
      limit: 5,
    });
  });

  test('requires a query', () => {
    expect(() => SearchInputSchema.parse({})).toThrow();
  });

  test('rejects an empty string query', () => {
    expect(() => SearchInputSchema.parse({ query: '' })).toThrow();
  });

  test('rejects an array query (multi-query AND search was dropped in the mem0 v2 port)', () => {
    expect(() => SearchInputSchema.parse({ query: ['alpha', 'beta'] })).toThrow();
  });

  test('accepts threshold within [0,1]', () => {
    expect(SearchInputSchema.parse({ query: 'memory search', threshold: 0.5 })).toEqual({
      query: 'memory search',
      threshold: 0.5,
    });
  });

  test('rejects threshold outside [0,1]', () => {
    expect(() => SearchInputSchema.parse({ query: 'memory search', threshold: 1.5 })).toThrow();
  });

  test('accepts explain flag', () => {
    expect(SearchInputSchema.parse({ query: 'memory search', explain: true })).toEqual({
      query: 'memory search',
      explain: true,
    });
  });

  test('rejects unknown search filter keys', () => {
    expect(() => SearchInputSchema.parse({ query: 'memory search', unknown: 'value' })).toThrow();
  });

  test('rejects limit outside range', () => {
    expect(() => SearchInputSchema.parse({ query: 'memory search', limit: 0 })).toThrow();
    expect(() => SearchInputSchema.parse({ query: 'memory search', limit: 51 })).toThrow();
  });
});
