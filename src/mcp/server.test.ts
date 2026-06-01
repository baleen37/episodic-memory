/**
 * MCP Server Tests
 *
 * Tests for the public memmem MCP search/read tool schemas.
 */

import { describe, test, expect } from 'bun:test';
import { SearchInputSchema, ReadInputSchema } from './schemas.js';

async function mockToolCall(toolName: string, args: unknown) {
  try {
    if (toolName === 'search') {
      SearchInputSchema.parse(args);
      return {
        content: [{ type: 'text', text: JSON.stringify({ memories: [], count: 0 }, null, 2) }],
        isError: false,
      };
    }

    if (toolName === 'read') {
      ReadInputSchema.parse(args);
      return {
        content: [{ type: 'text', text: '# Transcript Archive\n\nMock content' }],
        isError: false,
      };
    }

    throw new Error(`Unknown tool: ${toolName}`);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

describe('MCP Server - memmem__search tool', () => {
  describe('Query parameter validation', () => {
    test('rejects query shorter than 2 characters', async () => {
      const result = await mockToolCall('search', { query: 'a' });
      expect(result.isError).toBe(true);
    });

    test('rejects empty string query', async () => {
      const result = await mockToolCall('search', { query: '' });
      expect(result.isError).toBe(true);
    });

    test('accepts valid string query', async () => {
      const result = await mockToolCall('search', { query: 'test query' });
      expect(result.isError).toBe(false);
    });
  });

  describe('Date format validation', () => {
    test('rejects invalid after date format', async () => {
      const result = await mockToolCall('search', { query: 'test', after: '2024/01/01' });
      expect(result.isError).toBe(true);
    });

    test('rejects invalid before date format', async () => {
      const result = await mockToolCall('search', { query: 'test', before: '01-01-2024' });
      expect(result.isError).toBe(true);
    });

    test('accepts valid date filters in YYYY-MM-DD format', async () => {
      const result = await mockToolCall('search', {
        query: 'test',
        after: '2024-01-01',
        before: '2024-12-31',
      });
      expect(result.isError).toBe(false);
    });

    test('accepts date with invalid month because schema only validates format', async () => {
      const result = await mockToolCall('search', { query: 'test', after: '2024-13-01' });
      expect(result.isError).toBe(false);
    });
  });

  describe('Limit parameter validation', () => {
    test('accepts valid limits within range', async () => {
      expect((await mockToolCall('search', { query: 'test', limit: 1 })).isError).toBe(false);
      expect((await mockToolCall('search', { query: 'test', limit: 50 })).isError).toBe(false);
    });

    test('rejects limit outside range', async () => {
      expect((await mockToolCall('search', { query: 'test', limit: 0 })).isError).toBe(true);
      expect((await mockToolCall('search', { query: 'test', limit: 51 })).isError).toBe(true);
    });

    test('rejects non-integer limit', async () => {
      const result = await mockToolCall('search', { query: 'test', limit: 10.5 });
      expect(result.isError).toBe(true);
    });

    test('defaults to 10 when not specified', () => {
      const result = SearchInputSchema.safeParse({ query: 'test' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.limit).toBe(10);
    });
  });

  describe('Source kind filter validation', () => {
    test('accepts source_kind filter', async () => {
      const result = await mockToolCall('search', { query: 'test', source_kind: 'claude-projects' });
      expect(result.isError).toBe(false);
    });

    test('rejects empty source_kind', async () => {
      const result = await mockToolCall('search', { query: 'test', source_kind: '' });
      expect(result.isError).toBe(true);
    });
  });

  describe('Strict schema validation', () => {
    test('rejects unknown properties', async () => {
      const result = await mockToolCall('search', { query: 'test', unknownParam: 'value' });
      expect(result.isError).toBe(true);
    });
  });

  describe('Memory record result handling', () => {
    test('returns text content type', async () => {
      const result = await mockToolCall('search', { query: 'test search' });
      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
    });

    test('returns memory record container', async () => {
      const result = await mockToolCall('search', { query: 'test' });
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty('memories');
      expect(parsed).toHaveProperty('count');
    });
  });
});

describe('MCP Server - memmem__read tool', () => {
  describe('Archive path parameter validation', () => {
    test('rejects empty path', async () => {
      const result = await mockToolCall('read', { path: '' });
      expect(result.isError).toBe(true);
    });

    test('accepts valid archive paths', async () => {
      expect((await mockToolCall('read', { path: '/absolute/path/to/archive.jsonl' })).isError).toBe(false);
      expect((await mockToolCall('read', { path: 'relative/path/to/archive.jsonl' })).isError).toBe(false);
    });
  });

  describe('Line range parameters', () => {
    test('accepts startLine and endLine parameters', async () => {
      const result = await mockToolCall('read', { path: '/test/file.jsonl', startLine: 10, endLine: 50 });
      expect(result.isError).toBe(false);
    });

    test('rejects line numbers less than 1', async () => {
      expect((await mockToolCall('read', { path: '/test/file.jsonl', startLine: 0 })).isError).toBe(true);
      expect((await mockToolCall('read', { path: '/test/file.jsonl', endLine: 0 })).isError).toBe(true);
    });

    test('rejects non-integer startLine', async () => {
      const result = await mockToolCall('read', { path: '/test/file.jsonl', startLine: 10.5 });
      expect(result.isError).toBe(true);
    });

    test('works without line range parameters', async () => {
      const result = await mockToolCall('read', { path: '/test/file.jsonl' });
      expect(result.isError).toBe(false);
    });
  });

  describe('Output formatting', () => {
    test('returns text content type', async () => {
      const result = await mockToolCall('read', { path: '/test/file.jsonl' });
      expect(result.isError).toBe(false);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('Strict schema validation', () => {
    test('rejects unknown properties', async () => {
      const result = await mockToolCall('read', { path: '/test/file.jsonl', unknownParam: 'value' });
      expect(result.isError).toBe(true);
    });
  });
});

describe('MCP Server - Error handling', () => {
  test('returns error for unknown tool name', async () => {
    const result = await mockToolCall('unknown_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  test('error responses include isError flag', async () => {
    const result = await mockToolCall('search', { query: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
  });

  test('error responses have proper format', async () => {
    const result = await mockToolCall('read', { path: '' });
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toMatch(/^Error:/);
  });
});

describe('SearchInput Schema - Direct validation', () => {
  test('validates complete valid input', () => {
    const result = SearchInputSchema.safeParse({
      query: 'test',
      limit: 10,
      after: '2024-01-01',
      before: '2024-12-31',
      source_kind: 'claude-projects',
    });
    expect(result.success).toBe(true);
  });
});

describe('ReadInput Schema - Direct validation', () => {
  test('validates path only', () => {
    const result = ReadInputSchema.safeParse({ path: '/path/to/file.jsonl' });
    expect(result.success).toBe(true);
  });

  test('validates path with line range', () => {
    const result = ReadInputSchema.safeParse({ path: '/path/to/file.jsonl', startLine: 1, endLine: 100 });
    expect(result.success).toBe(true);
  });

  test('rejects missing path', () => {
    const result = ReadInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
