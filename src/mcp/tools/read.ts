/**
 * Read tool definition for MCP server.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

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
