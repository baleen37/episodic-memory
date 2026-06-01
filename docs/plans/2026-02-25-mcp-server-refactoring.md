# MCP Server Refactoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use core:executing-plans to implement this plan task-by-task.

**Goal:** Refactor `src/mcp/server.ts` (518 lines) into smaller, single-responsibility modules following the existing `read.ts` refactoring pattern.

**Architecture:** Extract schemas, handlers, query normalizer cache, and tool definitions into separate files. Keep `server.ts` as a thin orchestrator that wires everything together. This reduces cognitive load and makes each piece independently testable.

**Tech Stack:** TypeScript, Bun, Zod, MCP SDK

---

## Current Structure (518 lines)

```
src/mcp/server.ts
├── Zod schemas (3 schemas, 75 lines)
├── Error handling (handleError, 10 lines)
├── Handler deps injection (ServerHandlerDeps, 20 lines)
├── Query normalizer cache (60 lines)
├── Handlers (handleSearch, handleGetObservations, handleRead, 80 lines)
├── MCP server setup (Server constructor, 15 lines)
├── Tool definitions (ListToolsRequestSchema, 120 lines)
├── Tool call handler (CallToolRequestSchema, 90 lines)
├── Main + entrypoint (30 lines)
```

## Target Structure

```
src/mcp/
├── server.ts              # MCP server entrypoint (wiring only)
├── schemas.ts             # Zod schemas + types
├── handlers.ts            # Tool handlers (handleSearch, etc.)
├── query-normalizer.ts    # LLM query normalization cache
├── tools/
│   ├── search.ts          # search tool definition + handler
│   ├── get-observations.ts # get_observations tool definition + handler
│   └── read.ts            # read tool definition + handler
└── server.test.ts         # (existing, needs updates)
```

---

## Task 1: Extract Zod Schemas

**Files:**
- Create: `src/mcp/schemas.ts`
- Modify: `src/mcp/server.ts`
- Test: `src/mcp/schemas.test.ts`

**Step 1: Write the failing test**

Create `src/mcp/schemas.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import {
  SearchInputSchema,
  GetObservationsInputSchema,
  ReadInputSchema,
  type SearchInput,
  type GetObservationsInput,
  type ReadInput
} from './schemas.js';

describe('SearchInputSchema', () => {
  test('validates complete valid input', () => {
    const result = SearchInputSchema.safeParse({
      query: 'test query',
      limit: 20,
      after: '2024-01-01',
      before: '2024-12-31',
      projects: ['project1'],
      files: ['file1.ts']
    });

    expect(result.success).toBe(true);
  });

  test('applies default limit of 10', () => {
    const result = SearchInputSchema.safeParse({ query: 'test' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
    }
  });

  test('rejects query shorter than 2 characters', () => {
    const result = SearchInputSchema.safeParse({ query: 'a' });

    expect(result.success).toBe(false);
  });

  test('rejects invalid date format', () => {
    const result = SearchInputSchema.safeParse({
      query: 'test',
      after: '2024/01/01'
    });

    expect(result.success).toBe(false);
  });

  test('rejects unknown properties (strict mode)', () => {
    const result = SearchInputSchema.safeParse({
      query: 'test',
      unknownParam: 'value'
    });

    expect(result.success).toBe(false);
  });
});

describe('GetObservationsInputSchema', () => {
  test('validates array of IDs', () => {
    const result = GetObservationsInputSchema.safeParse({
      ids: [1, '2', 3]
    });

    expect(result.success).toBe(true);
  });

  test('rejects empty array', () => {
    const result = GetObservationsInputSchema.safeParse({ ids: [] });

    expect(result.success).toBe(false);
  });

  test('rejects array larger than 20', () => {
    const result = GetObservationsInputSchema.safeParse({
      ids: Array(21).fill(1)
    });

    expect(result.success).toBe(false);
  });

  test('defaults includeOriginal to false', () => {
    const result = GetObservationsInputSchema.safeParse({ ids: [1] });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeOriginal).toBe(false);
    }
  });
});

describe('ReadInputSchema', () => {
  test('validates path only', () => {
    const result = ReadInputSchema.safeParse({ path: '/path/to/file.jsonl' });

    expect(result.success).toBe(true);
  });

  test('validates path with pagination', () => {
    const result = ReadInputSchema.safeParse({
      path: '/path/to/file.jsonl',
      startLine: 1,
      endLine: 100
    });

    expect(result.success).toBe(true);
  });

  test('rejects empty path', () => {
    const result = ReadInputSchema.safeParse({ path: '' });

    expect(result.success).toBe(false);
  });

  test('rejects startLine less than 1', () => {
    const result = ReadInputSchema.safeParse({
      path: '/test.jsonl',
      startLine: 0
    });

    expect(result.success).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/mcp/schemas.test.ts`
Expected: FAIL - `Cannot find module './schemas.js'`

**Step 3: Write minimal implementation**

Create `src/mcp/schemas.ts`:

```typescript
/**
 * Zod schemas for MCP tool input validation.
 */

import { z } from 'zod';

// SearchInput Schema

export const SearchInputSchema = z
  .object({
    query: z
      .string()
      .min(2, 'Query must be at least 2 characters')
      .describe('Search query string'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum number of results to return (default: 10)'),
    after: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
      .optional()
      .describe('Only return results after this date (YYYY-MM-DD format)'),
    before: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
      .optional()
      .describe('Only return results before this date (YYYY-MM-DD format)'),
    projects: z
      .array(z.string().min(1))
      .optional()
      .describe('Filter results to specific project names'),
    files: z
      .array(z.string().min(1))
      .optional()
      .describe('Filter results to specific file paths'),
  })
  .strict();

export type SearchInput = z.infer<typeof SearchInputSchema>;

// GetObservationsInput Schema

export const GetObservationsInputSchema = z
  .object({
    ids: z
      .array(z.union([z.string(), z.number()]))
      .min(1, 'Must provide at least 1 observation ID')
      .max(20, 'Cannot get more than 20 observations at once')
      .describe('Array of observation IDs to retrieve'),
    includeOriginal: z
      .boolean()
      .default(false)
      .describe('Include original-language/source text (content_original) when available'),
  })
  .strict();

export type GetObservationsInput = z.infer<typeof GetObservationsInputSchema>;

// ReadInput Schema

export const ReadInputSchema = z
  .object({
    path: z
      .string()
      .min(1, 'Path is required')
      .describe('Path to the JSONL conversation file'),
    startLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Starting line number (1-indexed, inclusive)'),
    endLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Ending line number (1-indexed, inclusive)'),
  })
  .strict();

export type ReadInput = z.infer<typeof ReadInputSchema>;
```

**Step 4: Run test to verify it passes**

Run: `bun test src/mcp/schemas.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/mcp/schemas.ts src/mcp/schemas.test.ts
git commit -m "refactor(mcp): extract Zod schemas to schemas.ts"
```

---

## Task 2: Update server.ts to use schemas.ts

**Files:**
- Modify: `src/mcp/server.ts`

**Step 1: Update imports**

Replace the schema definitions with imports:

```typescript
import {
  SearchInputSchema,
  GetObservationsInputSchema,
  ReadInputSchema,
  type SearchInput,
  type GetObservationsInput,
  type ReadInput
} from './schemas.js';
```

**Step 2: Remove inline schema definitions**

Delete lines 33-106 (the inline schema definitions).

**Step 3: Run tests to verify nothing is broken**

Run: `bun test src/mcp/`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/mcp/server.ts
git commit -m "refactor(mcp): import schemas from schemas.ts"
```

---

## Task 3: Extract Query Normalizer Cache

**Files:**
- Create: `src/mcp/query-normalizer.ts`
- Modify: `src/mcp/server.ts`
- Test: `src/mcp/query-normalizer.test.ts`

**Step 1: Write the failing test**

Create `src/mcp/query-normalizer.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  getQueryNormalizerProvider,
  resetQueryNormalizerCache,
  type QueryNormalizerConfig
} from './query-normalizer.js';

describe('query-normalizer', () => {
  beforeEach(() => {
    resetQueryNormalizerCache();
  });

  describe('resetQueryNormalizerCache', () => {
    test('resets cached provider', async () => {
      const config: QueryNormalizerConfig = {
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        apiKey: 'test-key'
      };

      // First call creates provider
      const provider1 = await getQueryNormalizerProvider(
        () => config,
        async () => ({ complete: async () => '' }) as any
      );

      // Second call returns cached provider
      const provider2 = await getQueryNormalizerProvider(
        () => config,
        async () => ({ complete: async () => '' }) as any
      );

      expect(provider1).toBe(provider2);

      // Reset and create again
      resetQueryNormalizerCache();
      const provider3 = await getQueryNormalizerProvider(
        () => config,
        async () => ({ complete: async () => '' }) as any
      );

      expect(provider3).not.toBe(provider1);
    });

    test('returns undefined when config is missing', async () => {
      const provider = await getQueryNormalizerProvider(
        () => null,
        async () => ({ complete: async () => '' }) as any
      );

      expect(provider).toBeUndefined();
    });

    test('returns undefined when provider creation fails', async () => {
      const config: QueryNormalizerConfig = {
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        apiKey: 'bad-key'
      };

      const provider = await getQueryNormalizerProvider(
        () => config,
        async () => { throw new Error('API error'); }
      );

      expect(provider).toBeUndefined();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/mcp/query-normalizer.test.ts`
Expected: FAIL - `Cannot find module './query-normalizer.js'`

**Step 3: Write minimal implementation**

Create `src/mcp/query-normalizer.ts`:

```typescript
/**
 * Query normalizer cache for LLM-based query translation.
 *
 * Caches the LLM provider used for query normalization to avoid
 * recreating it on every search request.
 */

import type { LLMConfig, LLMProvider } from '../core/llm/index.js';
import { logDebug } from '../core/logger.js';

export type QueryNormalizerConfig = Pick<LLMConfig, 'provider' | 'model' | 'apiKey'>;

export type LoadConfigFn = () => LLMConfig | null;
export type CreateProviderFn = (config: LLMConfig) => Promise<LLMProvider>;

// Cache state
let cachedProvider: LLMProvider | undefined;
let cachedConfigKey: string | null = null;
let inFlightProvider: Promise<LLMProvider | undefined> | null = null;
let inFlightConfigKey: string | null = null;

/**
 * Reset the query normalizer cache. For testing only.
 */
export function resetQueryNormalizerCache(): void {
  cachedProvider = undefined;
  cachedConfigKey = null;
  inFlightProvider = null;
  inFlightConfigKey = null;
}

function getConfigCacheKey(config: QueryNormalizerConfig): string {
  return JSON.stringify([config.provider, config.model, config.apiKey]);
}

/**
 * Get or create a cached LLM provider for query normalization.
 *
 * Handles:
 * - Missing config (returns undefined)
 * - Provider creation errors (returns undefined, logs debug)
 * - Concurrent requests (deduplicates via in-flight promise)
 *
 * @param loadConfig - Function to load LLM config
 * @param createProvider - Function to create LLM provider
 * @returns Cached LLM provider or undefined if unavailable
 */
export async function getQueryNormalizerProvider(
  loadConfig: LoadConfigFn,
  createProvider: CreateProviderFn
): Promise<LLMProvider | undefined> {
  const config = loadConfig();
  if (!config) {
    return undefined;
  }

  const configKey = getConfigCacheKey(config);

  // Return cached provider if config matches
  if (cachedProvider && cachedConfigKey === configKey) {
    return cachedProvider;
  }

  // Deduplicate concurrent requests with same config
  if (inFlightProvider && inFlightConfigKey === configKey) {
    return inFlightProvider;
  }

  // Create new provider
  const providerPromise = createProvider(config)
    .then(provider => {
      cachedProvider = provider;
      cachedConfigKey = configKey;
      return provider;
    })
    .catch(error => {
      logDebug('query-normalizer: unavailable, falling back to original query', {
        error: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    })
    .finally(() => {
      if (inFlightConfigKey === configKey) {
        inFlightProvider = null;
        inFlightConfigKey = null;
      }
    });

  inFlightProvider = providerPromise;
  inFlightConfigKey = configKey;

  return providerPromise;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/mcp/query-normalizer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/mcp/query-normalizer.ts src/mcp/query-normalizer.test.ts
git commit -m "refactor(mcp): extract query normalizer cache to query-normalizer.ts"
```

---

## Task 4: Update server.ts to use query-normalizer.ts

**Files:**
- Modify: `src/mcp/server.ts`

**Step 1: Update imports and replace inline cache**

Replace lines 147-206 with imports and usage of the new module.

**Step 2: Run tests to verify nothing is broken**

Run: `bun test src/mcp/`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add src/mcp/server.ts
git commit -m "refactor(mcp): use query-normalizer module"
```

---

## Task 5: Extract Tool Handlers

**Files:**
- Create: `src/mcp/handlers.ts`
- Modify: `src/mcp/server.ts`
- Test: `src/mcp/handlers.test.ts`

**Step 1: Write the failing test**

Create `src/mcp/handlers.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  handleSearch,
  handleGetObservations,
  handleRead,
  type SearchResult,
  type ObservationOutput
} from './handlers.js';
import { openDatabase } from '../core/db.js';

describe('handlers', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Create minimal schema for testing
    db.exec(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        content_original TEXT,
        project TEXT NOT NULL,
        session_id TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  });

  describe('handleSearch', () => {
    test('returns empty array when no results', async () => {
      const results = await handleSearch(
        { query: 'nonexistent', limit: 10 },
        db,
        async () => null, // no config
        async () => ({ complete: async () => '' }) as any
      );

      expect(results).toEqual([]);
    });

    test('returns formatted search results', async () => {
      // Insert test observation
      db.exec(`
        INSERT INTO observations (title, content, project, timestamp, created_at)
        VALUES ('Test Title', 'Test content', 'test-project', 1704067200000, 1704067200000)
      `);

      const results = await handleSearch(
        { query: 'Test', limit: 10 },
        db,
        async () => null,
        async () => ({ complete: async () => '' }) as any
      );

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('id');
      expect(results[0]).toHaveProperty('title');
      expect(results[0]).toHaveProperty('project');
      expect(results[0]).toHaveProperty('timestamp');
    });
  });

  describe('handleGetObservations', () => {
    test('returns empty array for nonexistent IDs', async () => {
      const results = await handleGetObservations(
        { ids: [99999], includeOriginal: false },
        db
      );

      expect(results).toEqual([]);
    });

    test('returns observations by IDs', async () => {
      // Insert test observation
      const result = db.exec(`
        INSERT INTO observations (title, content, project, timestamp, created_at)
        VALUES ('Test', 'Content', 'project', 1704067200000, 1704067200000)
      `);

      const observations = await handleGetObservations(
        { ids: [1], includeOriginal: false },
        db
      );

      expect(observations).toHaveLength(1);
      expect(observations[0].title).toBe('Test');
      expect(observations[0].content).toBe('Content');
    });

    test('includes content_original when requested', async () => {
      db.exec(`
        INSERT INTO observations (title, content, content_original, project, timestamp, created_at)
        VALUES ('Test', 'Content', 'Original content', 'project', 1704067200000, 1704067200000)
      `);

      const observations = await handleGetObservations(
        { ids: [1], includeOriginal: true },
        db
      );

      expect(observations[0].content_original).toBe('Original content');
    });
  });

  describe('handleRead', () => {
    test('throws error for nonexistent file', () => {
      expect(() => handleRead({ path: '/nonexistent/file.jsonl' })).toThrow('File not found');
    });

    test('returns content for existing file', async () => {
      // Create temp file
      const tempPath = `/tmp/test-conversation-${Date.now()}.jsonl`;
      await Bun.write(tempPath, JSON.stringify({
        uuid: '1',
        type: 'user',
        timestamp: '2024-01-01T00:00:00Z',
        message: { role: 'user', content: 'Hello' }
      }) + '\n');

      try {
        const result = handleRead({ path: tempPath });
        expect(result).toContain('# Conversation');
      } finally {
        await Bun.file(tempPath).delete();
      }
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/mcp/handlers.test.ts`
Expected: FAIL - `Cannot find module './handlers.js'`

**Step 3: Write minimal implementation**

Create `src/mcp/handlers.ts`:

```typescript
/**
 * MCP tool handlers.
 *
 * Pure functions that implement the business logic for each tool.
 * Separated from MCP protocol wiring for testability.
 */

import type { Database } from 'bun:sqlite';
import { search } from '../core/search.js';
import { findByIds as getObservationsByIds } from '../core/observations.js';
import { readConversation } from '../core/read.js';
import { getQueryNormalizerProvider, type LoadConfigFn, type CreateProviderFn } from './query-normalizer.js';
import type { SearchInput, GetObservationsInput, ReadInput } from './schemas.js';

// Types for handler outputs

export interface SearchResult {
  id: string;
  title: string;
  project: string;
  timestamp: number;
}

export interface ObservationOutput {
  id: number;
  title: string;
  content: string;
  project: string;
  timestamp: number;
  content_original?: string;
}

// Handlers

export async function handleSearch(
  params: SearchInput,
  db: Database,
  loadConfig: LoadConfigFn,
  createProvider: CreateProviderFn
): Promise<SearchResult[]> {
  const queryNormalizerProvider = await getQueryNormalizerProvider(loadConfig, createProvider);

  const results = await search(params.query, {
    db,
    limit: params.limit,
    after: params.after,
    before: params.before,
    projects: params.projects,
    files: params.files,
    queryNormalizerProvider,
  });

  return results.map(r => ({
    id: String(r.id),
    title: r.title,
    project: r.project,
    timestamp: r.timestamp,
  }));
}

export async function handleGetObservations(
  params: GetObservationsInput,
  db: Database
): Promise<ObservationOutput[]> {
  // Convert string IDs to numbers
  const numericIds = params.ids.map(id =>
    typeof id === 'string' ? parseInt(id, 10) : id
  );

  const observations = await getObservationsByIds(db, numericIds);

  return observations.map(obs => ({
    id: obs.id,
    title: obs.title,
    content: obs.content,
    project: obs.project,
    timestamp: obs.timestamp,
    ...(params.includeOriginal && obs.contentOriginal ? { content_original: obs.contentOriginal } : {}),
  }));
}

export function handleRead(params: ReadInput): string {
  const result = readConversation(params.path, params.startLine, params.endLine);
  if (result === null) {
    throw new Error(`File not found: ${params.path}`);
  }
  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/mcp/handlers.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/mcp/handlers.ts src/mcp/handlers.test.ts
git commit -m "refactor(mcp): extract tool handlers to handlers.ts"
```

---

## Task 6: Update server.ts to use handlers.ts

**Files:**
- Modify: `src/mcp/server.ts`

**Step 1: Update imports**

Replace inline handler functions with imports from `handlers.ts`.

**Step 2: Remove inline handler definitions**

Delete the inline `handleSearch`, `handleGetObservations`, `handleRead` functions.

**Step 3: Run tests to verify nothing is broken**

Run: `bun test src/mcp/`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/mcp/server.ts
git commit -m "refactor(mcp): use handlers module"
```

---

## Task 7: Extract Tool Definitions

**Files:**
- Create: `src/mcp/tools/search.ts`
- Create: `src/mcp/tools/get-observations.ts`
- Create: `src/mcp/tools/read.ts`
- Create: `src/mcp/tools/index.ts`
- Modify: `src/mcp/server.ts`

**Step 1: Create tools/search.ts**

```typescript
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
```

**Step 2: Create tools/get-observations.ts**

```typescript
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
```

**Step 3: Create tools/read.ts**

```typescript
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
```

**Step 4: Create tools/index.ts**

```typescript
/**
 * MCP tool definitions.
 */

export { searchTool } from './search.js';
export { getObservationsTool } from './get-observations.js';
export { readTool } from './read.js';

import { searchTool } from './search.js';
import { getObservationsTool } from './get-observations.js';
import { readTool } from './read.js';

export const allTools = [searchTool, getObservationsTool, readTool];
```

**Step 5: Update server.ts to use tools**

Replace the inline tool definitions with imports from `./tools/index.js`.

**Step 6: Run tests to verify nothing is broken**

Run: `bun test src/mcp/`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src/mcp/tools/ src/mcp/server.ts
git commit -m "refactor(mcp): extract tool definitions to tools/ directory"
```

---

## Task 8: Extract Error Handling

**Files:**
- Create: `src/mcp/error.ts`
- Modify: `src/mcp/server.ts`

**Step 1: Create error.ts**

```typescript
/**
 * MCP error handling utilities.
 */

/**
 * Convert unknown error to user-friendly error message.
 */
export function handleError(error: unknown): string {
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}
```

**Step 2: Update server.ts**

Replace inline `handleError` with import from `./error.js`.

**Step 3: Run tests**

Run: `bun test src/mcp/`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/mcp/error.ts src/mcp/server.ts
git commit -m "refactor(mcp): extract error handling to error.ts"
```

---

## Task 9: Final Cleanup of server.ts

**Files:**
- Modify: `src/mcp/server.ts`

**Step 1: Review server.ts**

After all extractions, `server.ts` should only contain:
- MCP SDK imports
- Imports from local modules
- Server instance creation
- Request handler wiring
- Main function

**Step 2: Verify size reduction**

Run: `wc -l src/mcp/server.ts`
Expected: ~150 lines or less (from original 518)

**Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 4: Build**

Run: `bun run build`
Expected: Build succeeds

**Step 5: Type check**

Run: `bun run typecheck`
Expected: No errors

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor(mcp): final cleanup of server.ts"
```

---

## Summary

| Metric | Before | After |
|--------|--------|-------|
| `server.ts` lines | 518 | ~150 |
| Files | 1 | 8 |
| Test coverage | Good | Better (new modules tested) |
| Max nesting depth | 4+ | 2 |
| Single responsibility | No | Yes |

### New File Structure

```
src/mcp/
├── server.ts              # MCP server entrypoint (~150 lines)
├── schemas.ts             # Zod schemas + types (~80 lines)
├── schemas.test.ts        # Schema tests
├── handlers.ts            # Tool handlers (~70 lines)
├── handlers.test.ts       # Handler tests
├── query-normalizer.ts    # LLM query cache (~80 lines)
├── query-normalizer.test.ts # Cache tests
├── error.ts               # Error handling (~15 lines)
├── tools/
│   ├── index.ts           # Tool exports
│   ├── search.ts          # search tool definition
│   ├── get-observations.ts # get_observations tool definition
│   └── read.ts            # read tool definition
└── server.test.ts         # (existing)
```

### Benefits

1. **Single Responsibility**: Each file has one clear purpose
2. **Testability**: Each module can be tested in isolation
3. **Discoverability**: Easy to find specific functionality
4. **Maintainability**: Changes are localized
5. **Reduced Cognitive Load**: Smaller files are easier to understand
