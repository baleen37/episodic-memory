/**
 * MCP Server Tests
 *
 * Tests for the public memmem MCP search tool schema (fetch was removed in the
 * mem0 v2 port — there is no source transcript to read back).
 */

import { describe, test, expect } from 'bun:test';
import { SearchInputSchema } from './schemas.js';

async function mockToolCall(toolName: string, args: unknown) {
  try {
    if (toolName === 'search') {
      SearchInputSchema.parse(args);
      return {
        content: [{ type: 'text', text: JSON.stringify({ results: [] }, null, 2) }],
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
    test('rejects empty string query', async () => {
      const result = await mockToolCall('search', { query: '' });
      expect(result.isError).toBe(true);
    });

    test('rejects missing query', async () => {
      const result = await mockToolCall('search', {});
      expect(result.isError).toBe(true);
    });

    test('accepts valid string query', async () => {
      const result = await mockToolCall('search', { query: 'test query' });
      expect(result.isError).toBe(false);
    });

    test('rejects an array query (multi-query AND search was dropped in the mem0 v2 port)', async () => {
      const result = await mockToolCall('search', { query: ['alpha', 'beta'] });
      expect(result.isError).toBe(true);
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
  });

  describe('Threshold parameter validation', () => {
    test('accepts threshold within [0,1]', async () => {
      const result = await mockToolCall('search', { query: 'test', threshold: 0.3 });
      expect(result.isError).toBe(false);
    });

    test('rejects threshold outside [0,1]', async () => {
      const result = await mockToolCall('search', { query: 'test', threshold: 1.5 });
      expect(result.isError).toBe(true);
    });
  });

  describe('Explain parameter validation', () => {
    test('accepts explain boolean', async () => {
      const result = await mockToolCall('search', { query: 'test', explain: true });
      expect(result.isError).toBe(false);
    });

    test('rejects non-boolean explain', async () => {
      const result = await mockToolCall('search', { query: 'test', explain: 'yes' });
      expect(result.isError).toBe(true);
    });
  });

  describe('Strict schema validation', () => {
    test('rejects unknown properties', async () => {
      const result = await mockToolCall('search', { query: 'test', unknownParam: 'value' });
      expect(result.isError).toBe(true);
    });

    test('rejects removed date filters (after/before had no mem0 v2 equivalent)', async () => {
      const result = await mockToolCall('search', { query: 'test', after: '2024-01-01' });
      expect(result.isError).toBe(true);
    });

    test('rejects the removed source_kind filter', async () => {
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
      expect(parsed).not.toHaveProperty('usage');
    });
  });
});

describe('MCP Server - fetch tool removed', () => {
  test('fetch is not a recognized tool', async () => {
    const result = await mockToolCall('fetch', { id: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});

describe('MCP Server - Error handling', () => {
  test('returns error for unknown tool name', async () => {
    const result = await mockToolCall('unknown_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  test('error responses include isError flag', async () => {
    const result = await mockToolCall('search', {});
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
  });

  test('error responses have proper format', async () => {
    const result = await mockToolCall('search', {});
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
      threshold: 0.2,
      explain: false,
    });
    expect(result.success).toBe(true);
  });
});
