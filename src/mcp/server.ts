import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openMemoryDb } from '../core/memory/schema.js';
import {
  SearchInputSchema,
  ReadInputSchema,
  type SearchInput,
  type ReadInput,
} from './schemas.js';
import {
  handleRead,
  handleSearch,
} from './handlers.js';
import type { CompactSearchResult, ReadMemoryResult } from './handlers.js';
import { TOOLS } from './tools.js';

export function handleError(error: unknown): string {
  return error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
}

export { SearchInputSchema, ReadInputSchema };
export type { SearchInput, ReadInput, CompactSearchResult, ReadMemoryResult };

const server = new Server(
  {
    name: 'episodic-memory',
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
    tools: TOOLS,
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (name === 'search') {
      const params = SearchInputSchema.parse(args);
      const db = openMemoryDb();
      try {
        const result = await handleSearch(params, db);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        };
      } finally {
        db.close();
      }
    }

    if (name === 'read') {
      const params = ReadInputSchema.parse(args);
      const db = openMemoryDb();
      try {
        const result = handleRead(params, db);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        };
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

  // 클라이언트(부모 claude)가 stdin을 닫으면 더 받을 요청이 없으므로 종료한다.
  // claude 크래시/강제 종료 시 서버가 고아로 남는 것을 방지.
  process.stdin.on('close', () => process.exit(0));
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
