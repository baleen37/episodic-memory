/**
 * MCP Server Tests
 *
 * Tests for the public memmem MCP search/fetch tool schemas.
 */

import { describe, test, expect } from 'bun:test';
import { SearchInputSchema, FetchInputSchema } from './schemas.js';

async function mockToolCall(toolName: string, args: unknown) {
  try {
    if (toolName === 'search') {
      SearchInputSchema.parse(args);
      return {
        content: [{ type: 'text', text: JSON.stringify({ results: [] }, null, 2) }],
        isError: false,
      };
    }

    if (toolName === 'fetch') {
      FetchInputSchema.parse(args);
      return {
        content: [{ type: 'text', text: '# Conversation\n\nMock content' }],
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

  describe('Strict schema validation', () => {
    test('rejects unknown properties', async () => {
      const result = await mockToolCall('search', { query: 'test', unknownParam: 'value' });
      expect(result.isError).toBe(true);
    });

    test('rejects removed source_kind filter', async () => {
      const result = await mockToolCall('search', { query: 'test', source_kind: 'claude-code-projects' });
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

    test('returns results container', async () => {
      const result = await mockToolCall('search', { query: 'test' });
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty('results');
    });
  });
});

describe('MCP Server - memmem__fetch tool', () => {
  describe('Id parameter validation', () => {
    test('accepts numeric id', async () => {
      const result = await mockToolCall('fetch', { id: 42 });
      expect(result.isError).toBe(false);
    });

    test('accepts string id', async () => {
      const result = await mockToolCall('fetch', { id: '42' });
      expect(result.isError).toBe(false);
    });

    test('rejects empty string id', async () => {
      const result = await mockToolCall('fetch', { id: '' });
      expect(result.isError).toBe(true);
    });

    test('rejects missing id', async () => {
      const result = await mockToolCall('fetch', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('Output formatting', () => {
    test('returns text content type', async () => {
      const result = await mockToolCall('fetch', { id: 1 });
      expect(result.isError).toBe(false);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('Strict schema validation', () => {
    test('rejects unknown properties', async () => {
      const result = await mockToolCall('fetch', { id: 1, unknownParam: 'value' });
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
    const result = await mockToolCall('fetch', { id: '' });
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
    });
    expect(result.success).toBe(true);
  });
});

describe('FetchInput Schema - Direct validation', () => {
  test('validates numeric id', () => {
    const result = FetchInputSchema.safeParse({ id: 7 });
    expect(result.success).toBe(true);
  });

  test('validates string id', () => {
    const result = FetchInputSchema.safeParse({ id: '7' });
    expect(result.success).toBe(true);
  });

  test('rejects missing id', () => {
    const result = FetchInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
