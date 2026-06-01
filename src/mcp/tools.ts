import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const searchTool: Tool = {
  name: 'search',
  description: 'Search indexed event/fact memory records. Returns compact source-linked memories with kind, text, archive path, line range, source kind, project, timestamp, and score.',
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

export const readTool: Tool = {
  name: 'read',
  description: 'Read a transcript archive file, optionally limited by 1-indexed line range.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        minLength: 1,
        description: 'Path to the JSONL transcript file',
      },
      startLine: {
        type: 'integer',
        minimum: 1,
        description: 'Starting line number (1-indexed, inclusive)',
      },
      endLine: {
        type: 'integer',
        minimum: 1,
        description: 'Ending line number (1-indexed, inclusive)',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  annotations: {
    title: 'Read Transcript',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const allTools = [searchTool, readTool];
