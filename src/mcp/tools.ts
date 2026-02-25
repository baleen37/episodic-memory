/**
 * MCP tool definitions.
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

export const getObservationsTool: Tool = {
  name: 'get_observations',
  description: `Get full observation details (Layer 2 of progressive disclosure). Use after search() to retrieve complete information including narrative, facts, concepts, and files. Returns ~200-500 tokens per observation. Essential for understanding the complete context behind decisions and discoveries.`,
  inputSchema: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: ['string', 'number'] },
        minItems: 1,
        maxItems: 20,
        description: 'Array of observation IDs to retrieve'
      },
      includeOriginal: {
        type: 'boolean',
        default: false,
        description: 'Include original-language/source text (content_original) when available'
      }
    },
    required: ['ids'],
    additionalProperties: false,
  },
  annotations: {
    title: 'Get Full Observation Details',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const readTool: Tool = {
  name: 'read',
  description: `Returns compressed conversation data from indexed DB (Layer 3 of progressive disclosure). Use to extract detailed context after finding relevant observations with search() and getting full details with get_observations(). Essential for understanding the complete rationale, evolution, and gotchas behind past decisions. Use startLine/endLine pagination for large conversations to avoid context bloat (line numbers are 1-indexed).`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        minLength: 1,
        description: 'Path to the JSONL conversation file'
      },
      startLine: {
        type: 'number',
        minimum: 1,
        description: 'Starting line number (1-indexed, inclusive)'
      },
      endLine: {
        type: 'number',
        minimum: 1,
        description: 'Ending line number (1-indexed, inclusive)'
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  annotations: {
    title: 'Show Full Conversation',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const allTools = [searchTool, getObservationsTool, readTool];
