import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const searchTool: Tool = {
  name: 'search',
  description: 'Search stored memories. Returns memory records scored by hybrid semantic + keyword relevance.',
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
      limit: { type: 'number', description: 'Max results. Default 20.' },
      threshold: { type: 'number', description: 'Minimum semantic score, 0-1. Default 0.1.' },
      explain: { type: 'boolean', description: 'Include score breakdown. Default false.' },
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

export const TOOLS = [searchTool] as const;
