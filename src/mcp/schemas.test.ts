import { describe, expect, test } from 'bun:test';
import { ReadInputSchema, SearchInputSchema } from './schemas.js';

describe('MCP schemas', () => {
  test('validates memory search input', () => {
    expect(SearchInputSchema.parse({ query: 'memory search', limit: 5 })).toEqual({
      query: 'memory search',
      limit: 5,
    });
  });

  test('defaults limit to 10', () => {
    expect(SearchInputSchema.parse({ query: 'memory search' })).toEqual({
      query: 'memory search',
      limit: 10,
    });
  });

  test('requires a query', () => {
    expect(() => SearchInputSchema.parse({})).toThrow();
  });

  test('rejects an empty string query', () => {
    expect(() => SearchInputSchema.parse({ query: '' })).toThrow();
  });

  test('accepts an array of 2-5 query strings for AND search', () => {
    expect(SearchInputSchema.parse({ query: ['alpha', 'beta'] })).toEqual({
      query: ['alpha', 'beta'],
      limit: 10,
    });
    expect(SearchInputSchema.parse({ query: ['a', 'b', 'c', 'd', 'e'] })).toEqual({
      query: ['a', 'b', 'c', 'd', 'e'],
      limit: 10,
    });
  });

  test('rejects an array with fewer than 2 queries', () => {
    expect(() => SearchInputSchema.parse({ query: ['only-one'] })).toThrow();
  });

  test('rejects an array with more than 5 queries', () => {
    expect(() => SearchInputSchema.parse({ query: ['a', 'b', 'c', 'd', 'e', 'f'] })).toThrow();
  });

  test('rejects an array containing an empty query', () => {
    expect(() => SearchInputSchema.parse({ query: ['alpha', ''] })).toThrow();
  });

  test('rejects removed threshold and explain inputs', () => {
    expect(() => SearchInputSchema.parse({ query: 'memory search', threshold: 0.5 })).toThrow();
    expect(() => SearchInputSchema.parse({ query: 'memory search', explain: false })).toThrow();
  });

  test('rejects unknown search filter keys', () => {
    expect(() => SearchInputSchema.parse({ query: 'memory search', unknown: 'value' })).toThrow();
  });

  test('rejects limit outside range', () => {
    expect(() => SearchInputSchema.parse({ query: 'memory search', limit: 0 })).toThrow();
    expect(() => SearchInputSchema.parse({ query: 'memory search', limit: 51 })).toThrow();
  });

  test('validates a bounded multi-read input', () => {
    expect(ReadInputSchema.parse({ ids: ['e_123'] })).toEqual({ ids: ['e_123'] });
    expect(ReadInputSchema.parse({ ids: Array.from({ length: 10 }, (_, i) => `e_${i}`) })).toBeTruthy();
    expect(() => ReadInputSchema.parse({})).toThrow();
    expect(() => ReadInputSchema.parse({ ids: [] })).toThrow();
    expect(() => ReadInputSchema.parse({ ids: Array.from({ length: 11 }, (_, i) => `e_${i}`) })).toThrow();
    expect(() => ReadInputSchema.parse({ ids: ['e_1'], extra: true })).toThrow();
  });
});
