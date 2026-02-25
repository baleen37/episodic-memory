/**
 * Get observations tool definition for MCP server.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

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
