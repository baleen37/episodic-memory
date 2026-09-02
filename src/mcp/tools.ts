import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const searchTool: Tool = {
  name: 'search',
  description: 'Search stored memories. Returns compact cards; use read with their ids for full records.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        anyOf: [
          { type: 'string', minLength: 1 },
          {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            minItems: 2,
            maxItems: 5,
          },
        ],
        description: 'Search query. Use a string for normal search, or an array of 2-5 queries for strict AND search.',
      },
      limit: { type: 'number', description: 'Max results. Default 10.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: {
    title: 'Search Memories',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const readTool: Tool = {
  name: 'read',
  description: 'Read full stored memory records by one or more ids returned from search.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        maxItems: 10,
      },
    },
    required: ['ids'],
    additionalProperties: false,
  },
  annotations: {
    title: 'Read Memories',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const TOOLS = [searchTool, readTool] as const;
