import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openDatabase } from '../core/db.js';
import {
  SearchInputSchema,
  FetchInputSchema,
  type SearchInput,
  type FetchInput,
} from './schemas.js';
import {
  handleSearch,
  handleFetch,
  type SearchResult,
} from './handlers.js';
import { allTools } from './tools.js';

export function handleError(error: unknown): string {
  return error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
}

export { SearchInputSchema, FetchInputSchema };
export type { SearchInput, FetchInput, SearchResult };

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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: allTools,
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (name === 'search') {
      const params = SearchInputSchema.parse(args);
      const db = openDatabase();
      try {
        const results = await handleSearch(params, db);
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

    if (name === 'fetch') {
      const params = FetchInputSchema.parse(args);
      const db = openDatabase();
      try {
        const result = handleFetch(params, db);
        return { content: [{ type: 'text', text: result }] };
      } finally {
        db.close();
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
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

async function main() {
  console.error('Conversation Memory MCP server running via stdio');

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function shouldRunAsEntrypoint(): boolean {
  return import.meta.main;
}

if (shouldRunAsEntrypoint()) {
  main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}
