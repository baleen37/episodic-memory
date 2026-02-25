import { describe, test, expect } from 'bun:test';
import {
  SearchInputSchema,
  GetObservationsInputSchema,
  ReadInputSchema,
  type SearchInput,
  type GetObservationsInput,
  type ReadInput
} from './schemas.js';

describe('SearchInputSchema', () => {
  test('validates complete valid input', () => {
    const result = SearchInputSchema.safeParse({
      query: 'test query',
      limit: 20,
      after: '2024-01-01',
      before: '2024-12-31',
      projects: ['project1'],
      files: ['file1.ts']
    });

    expect(result.success).toBe(true);
  });

  test('applies default limit of 10', () => {
    const result = SearchInputSchema.safeParse({ query: 'test' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
    }
  });

  test('rejects query shorter than 2 characters', () => {
    const result = SearchInputSchema.safeParse({ query: 'a' });

    expect(result.success).toBe(false);
  });

  test('rejects invalid date format', () => {
    const result = SearchInputSchema.safeParse({
      query: 'test',
      after: '2024/01/01'
    });

    expect(result.success).toBe(false);
  });

  test('rejects unknown properties (strict mode)', () => {
    const result = SearchInputSchema.safeParse({
      query: 'test',
      unknownParam: 'value'
    });

    expect(result.success).toBe(false);
  });
});

describe('GetObservationsInputSchema', () => {
  test('validates array of IDs', () => {
    const result = GetObservationsInputSchema.safeParse({
      ids: [1, '2', 3]
    });

    expect(result.success).toBe(true);
  });

  test('rejects empty array', () => {
    const result = GetObservationsInputSchema.safeParse({ ids: [] });

    expect(result.success).toBe(false);
  });

  test('rejects array larger than 20', () => {
    const result = GetObservationsInputSchema.safeParse({
      ids: Array(21).fill(1)
    });

    expect(result.success).toBe(false);
  });

  test('defaults includeOriginal to false', () => {
    const result = GetObservationsInputSchema.safeParse({ ids: [1] });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeOriginal).toBe(false);
    }
  });
});

describe('ReadInputSchema', () => {
  test('validates path only', () => {
    const result = ReadInputSchema.safeParse({ path: '/path/to/file.jsonl' });

    expect(result.success).toBe(true);
  });

  test('validates path with pagination', () => {
    const result = ReadInputSchema.safeParse({
      path: '/path/to/file.jsonl',
      startLine: 1,
      endLine: 100
    });

    expect(result.success).toBe(true);
  });

  test('rejects empty path', () => {
    const result = ReadInputSchema.safeParse({ path: '' });

    expect(result.success).toBe(false);
  });

  test('rejects startLine less than 1', () => {
    const result = ReadInputSchema.safeParse({
      path: '/test.jsonl',
      startLine: 0
    });

    expect(result.success).toBe(false);
  });
});
