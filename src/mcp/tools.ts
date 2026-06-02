import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const searchTool: Tool = {
  name: 'search',
  description: 'Search indexed event/fact memory records. Returns compact memory cards (id, kind, text, score). Call the fetch tool with a result id to read the full source transcript for that memory.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 2,
        description: 'Search query string',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Maximum number of results to return',
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
    required: ['query'],
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
  description: 'Fetch the full source transcript for a memory record returned by search. Takes the record id and returns the original conversation transcript (rendered as markdown) for that memory.',
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
