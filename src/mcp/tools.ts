import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const searchTool: Tool = {
  name: 'search',
  description: 'Find compact memory candidates. Returns id, kind, project, description, and optional score. Use fetch with a result id only when you need the source transcript.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        anyOf: [
          { type: 'string', minLength: 2 },
          { type: 'array', items: { type: 'string', minLength: 2 }, minItems: 2, maxItems: 5 },
        ],
        description: 'Search query. Use a string for normal search, an array of 2-5 strings for AND search, or omit to list recent records.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Maximum candidate count to return',
      },
      after: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description: 'Only return results after this date (YYYY-MM-DD format)',
      },
      before: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description: 'Only return results before this date (YYYY-MM-DD format)',
      },
      source_kind: {
        type: 'string',
        minLength: 1,
        description: 'Filter results to a transcript source kind',
      },
    },
    additionalProperties: false,
  },
  annotations: {
    title: 'Search Memory Records',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const fetchTool: Tool = {
  name: 'fetch',
  description: 'Read the source transcript for one memory candidate returned by search.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        anyOf: [{ type: 'string', minLength: 1 }, { type: 'integer' }],
        description: 'Memory record id from a search result',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  annotations: {
    title: 'Fetch Memory Source Transcript',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const allTools = [searchTool, fetchTool];
