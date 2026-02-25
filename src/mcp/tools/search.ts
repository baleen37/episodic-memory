/**
 * Search tool definition for MCP server.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const searchTool: Tool = {
  name: 'search',
  description: `Gives you memory across sessions using observations (structured insights) and conversations. Use BEFORE every task to recover decisions, solutions, and avoid reinventing work. Progressive disclosure: 1) search returns compact observations (~30t), 2) get_observations() for full details (~200-500t), 3) read() for raw conversation (~500-2000t). Internal search strategies: vector_search first, then keyword_search fallback. Supports filters by projects/files and date ranges.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 2,
        description: 'Search query string'
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Maximum number of results to return'
      },
      after: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description: 'Only return results after this date (YYYY-MM-DD format)'
      },
      before: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description: 'Only return results before this date (YYYY-MM-DD format)'
      },
      projects: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        description: 'Filter results to specific project names'
      },
      files: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        description: 'Filter results to specific file paths'
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: {
    title: 'Search Conversation Memory',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};
