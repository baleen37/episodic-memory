import { describe, expect, test } from 'bun:test';
import { searchTool } from './tools.js';

describe('searchTool', () => {
  test('tool description tells the caller to query in English', () => {
    expect(searchTool.description).toMatch(/in English/i);
  });

  test('query field description tells the caller to write the query in English', () => {
    const queryDesc = (searchTool.inputSchema.properties as Record<string, { description?: string }>)
      .query?.description;
    expect(queryDesc).toMatch(/in English/i);
  });
});
