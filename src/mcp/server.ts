/**
 * MCP Server for Conversation Memory.
 *
 * Simplified 3-tool architecture:
 * 1. search - Single query string, returns compact observations
 * 2. get_observations - Full details by ID array
 * 3. read - Raw conversation from JSONL
 *
 * Progressive disclosure:
 * - Layer 1: search() returns compact observations (~30t)
 * - Layer 2: get_observations() returns full details (~200-500t)
 * - Layer 3: read() returns raw conversation (~500-2000t)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openDatabase } from '../core/db.js';
import { loadConfig, createProvider } from '../core/llm/index.js';
import {
  SearchInputSchema,
  GetObservationsInputSchema,
  ReadInputSchema,
  type SearchInput,
  type GetObservationsInput,
  type ReadInput,
} from './schemas.js';
import {
  handleSearch,
  handleGetObservations,
  handleRead,
  formatObservations,
  type SearchResult,
} from './handlers.js';
import { allTools } from './tools.js';

export function handleError(error: unknown): string {
  return error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
}

// Re-export schemas for backward compatibility
export { SearchInputSchema, GetObservationsInputSchema, ReadInputSchema };
export type { SearchInput, GetObservationsInput, ReadInput };

// Re-export handler types for backward compatibility
export type { SearchResult };

// Create MCP Server

const server = new Server(
  {
    name: 'memmem',
    version: '3.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register Tools

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: allTools,
  };
});

// Handle Tool Calls

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (name === 'search') {
      const params = SearchInputSchema.parse(args);

      // Open database (persistent storage)
      const db = openDatabase();
      try {
        const results = await handleSearch(params, db, loadConfig, createProvider);

        // Return compact observations as JSON
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ results }, null, 2),
            },
          ],
        };
      } finally {
        db.close();
      }
    }

    if (name === 'get_observations') {
      const params = GetObservationsInputSchema.parse(args);

      // Open database (persistent storage)
      const db = openDatabase();
      try {
        const observations = await handleGetObservations(params, db);
        const output = formatObservations(observations, params.includeOriginal ?? false);
        return { content: [{ type: 'text', text: output }] };
      } finally {
        db.close();
      }
    }

    if (name === 'read') {
      const params = ReadInputSchema.parse(args);
      const result = handleRead(params);
      return { content: [{ type: 'text', text: result }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    // Return errors within the result (not as protocol errors)
    return {
      content: [
        {
          type: 'text',
          text: handleError(error),
        },
      ],
      isError: true,
    };
  }
});

// Main Function

async function main() {
  console.error('Conversation Memory MCP server running via stdio');

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run the Server

export function shouldRunAsEntrypoint(): boolean {
  return process.env.VITEST !== 'true';
}

if (shouldRunAsEntrypoint()) {
  main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}
