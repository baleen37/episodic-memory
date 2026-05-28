# Episodic Memory Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace memmem's observation-based memory system with a source-adapter transcript index that supports Claude Code and Codex transcripts, default hybrid search, and transcript reading.

**Architecture:** The archive is the source of truth. Source adapters discover and parse transcripts, sync copies them into `conversation-archive/<source_kind>/<relative path>`, the indexer reindexes changed archive files from scratch into `exchanges`, `tool_calls`, and `vec_exchanges`, and CLI/MCP read from that index.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, `sqlite-vec`, `@huggingface/transformers`, Zod, MCP SDK, `bun test`.

---

## File Structure

Create these files:

- `src/core/sources/types.ts` — shared source adapter, normalized exchange, and normalized tool call types.
- `src/core/sources/claude.ts` — Claude Code source adapters and Claude JSONL parser.
- `src/core/sources/codex.ts` — Codex source adapter and Codex rollout parser.
- `src/core/sources/index.ts` — exports built-in adapters and source discovery helpers.
- `src/core/indexer.ts` — archive-file reindexing into exchange tables and vectors.
- `src/cli/search.ts` — CLI search command.
- `src/cli/read.ts` — CLI read command.

Rewrite these files:

- `src/core/db.ts` — replace observation schema with `exchanges`, `tool_calls`, `vec_exchanges` schema and helpers.
- `src/core/search.ts` — replace observation search with default hybrid exchange search.
- `src/cli/sync.ts` — replace “missing observation embeddings” sync with source sync + archive indexing.
- `src/cli/main.ts` — expose only `sync`, `search`, `read`.
- `src/mcp/schemas.ts` — remove observation schemas and add transcript search/read schemas.
- `src/mcp/handlers.ts` — remove `get_observations`, call new exchange search/read handlers.
- `src/mcp/tools.ts` — expose only `search` and `read`.
- `src/mcp/server.ts` — remove `get_observations` routing.

Keep and adapt:

- `src/core/embeddings.ts`, `src/core/embeddings-model.ts`, `src/core/constants.ts` — keep `Supabase/gte-small` and 384 dimensions.
- `src/core/read.ts` — keep markdown rendering for Claude JSONL, add tolerant fallback for non-Claude JSONL lines.
- `src/core/paths.ts` — keep config/archive/db path helpers.

Delete or stop routing to these old observation flows after replacements are in place:

- `src/cli/record.ts`, `src/cli/extract.ts`, `src/cli/recall.ts` and their tests.
- Observation-specific tests in `src/core/db.test.ts`, `src/core/search.test.ts`, `src/mcp/*` as they are replaced by exchange tests.

---

### Task 1: Replace DB Schema With Exchange Tables

**Files:**
- Modify: `src/core/db.ts`
- Test: `src/core/db.test.ts`

- [ ] **Step 1: Write failing schema tests**

Replace `src/core/db.test.ts` with tests for exchange, tool call, vector table creation, cascade deletion, and stale embedding lookup:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { initDatabase, insertExchange, insertToolCall, deleteExchangeIndexForArchivePath, getArchivePathsNeedingReindex, CURRENT_EMBEDDING_VERSION } from './db.js';

let db: ReturnType<typeof initDatabase> | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe('exchange database schema', () => {
  test('creates exchange schema tables', () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();

    const tables = db.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual')").all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);

    expect(names).toContain('exchanges');
    expect(names).toContain('tool_calls');
    expect(names).toContain('vec_exchanges');
  });

  test('inserts exchange and cascades tool calls on delete', () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();

    const exchangeId = insertExchange(db, {
      archivePath: '/tmp/archive/claude-projects/session.jsonl',
      lineStart: 1,
      lineEnd: 2,
      sourceKind: 'claude-projects',
      sessionId: 'session-1',
      project: 'project-a',
      cwd: '/tmp/project-a',
      gitBranch: 'main',
      model: 'claude-sonnet',
      provider: 'anthropic',
      metadataJson: JSON.stringify({ version: '1.0.0' }),
      timestamp: 1710000000000,
      userText: 'How should we index transcripts?',
      assistantText: 'Use exchange rows.',
      embeddingText: 'How should we index transcripts?\nUse exchange rows.',
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    insertToolCall(db, {
      exchangeId,
      toolName: 'Read',
      callId: 'toolu_1',
      input: '{"file_path":"src/core/db.ts"}',
      output: 'file content',
      status: 'success',
    });

    deleteExchangeIndexForArchivePath(db, '/tmp/archive/claude-projects/session.jsonl');

    const toolCount = db.query('SELECT COUNT(*) AS count FROM tool_calls').get() as { count: number };
    expect(toolCount.count).toBe(0);
  });

  test('finds archive paths missing exchange rows or stale embeddings', () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();

    insertExchange(db, {
      archivePath: '/tmp/archive/codex-sessions/rollout.jsonl',
      lineStart: 1,
      lineEnd: 3,
      sourceKind: 'codex-sessions',
      sessionId: 'codex-session',
      project: 'project-b',
      cwd: '/tmp/project-b',
      gitBranch: null,
      model: 'gpt-5.1',
      provider: 'openai',
      metadataJson: null,
      timestamp: 1710000000000,
      userText: 'Run tests',
      assistantText: 'Tests passed',
      embeddingText: 'Run tests\nTests passed',
      embeddingVersion: CURRENT_EMBEDDING_VERSION - 1,
    });

    const paths = getArchivePathsNeedingReindex(db, ['/tmp/archive/codex-sessions/rollout.jsonl', '/tmp/archive/claude-projects/new.jsonl']);
    expect(paths.sort()).toEqual(['/tmp/archive/claude-projects/new.jsonl', '/tmp/archive/codex-sessions/rollout.jsonl']);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/core/db.test.ts`

Expected: FAIL because `insertExchange`, `insertToolCall`, `deleteExchangeIndexForArchivePath`, `getArchivePathsNeedingReindex`, and `CURRENT_EMBEDDING_VERSION` are not implemented.

- [ ] **Step 3: Implement exchange schema and helpers**

Rewrite `src/core/db.ts` around the new schema. Keep `initDatabase()` wiping behavior for tests and `openDatabase()` preserving behavior for production. Use this exported API shape:

```ts
export const CURRENT_EMBEDDING_VERSION = 1;

export interface ExchangeInsert {
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  sourceKind: string;
  sessionId: string | null;
  project: string | null;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  provider: string | null;
  metadataJson: string | null;
  timestamp: number | null;
  userText: string;
  assistantText: string;
  embeddingText: string;
  embeddingVersion: number;
}

export interface ToolCallInsert {
  exchangeId: number;
  toolName: string | null;
  callId: string | null;
  input: string | null;
  output: string | null;
  status: string | null;
}
```

Implement `createDatabase()` with these SQL statements:

```ts
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS exchanges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    archive_path TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    source_kind TEXT NOT NULL,
    session_id TEXT,
    project TEXT,
    cwd TEXT,
    git_branch TEXT,
    model TEXT,
    provider TEXT,
    metadata_json TEXT,
    timestamp INTEGER,
    user_text TEXT NOT NULL,
    assistant_text TEXT NOT NULL,
    embedding_text TEXT NOT NULL,
    embedding_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(archive_path, line_start, line_end)
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_exchanges_archive_path ON exchanges(archive_path)');
db.exec('CREATE INDEX IF NOT EXISTS idx_exchanges_source_kind ON exchanges(source_kind)');
db.exec('CREATE INDEX IF NOT EXISTS idx_exchanges_timestamp ON exchanges(timestamp DESC)');

db.exec(`
  CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange_id INTEGER NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
    tool_name TEXT,
    call_id TEXT,
    input TEXT,
    output TEXT,
    status TEXT,
    created_at INTEGER NOT NULL
  )
`);
```

Create `vec_exchanges` with `float[${EMBEDDING_DIM}]`. Implement vector cleanup explicitly inside `deleteExchangeIndexForArchivePath()` by selecting IDs before deleting exchange rows, deleting vector rows by string ID, then deleting exchanges.

- [ ] **Step 4: Run DB tests**

Run: `bun test src/core/db.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/db.ts src/core/db.test.ts
git commit -m "feat: add exchange database schema"
```

---

### Task 2: Add Source Adapter Types and Parsers

**Files:**
- Create: `src/core/sources/types.ts`
- Create: `src/core/sources/claude.ts`
- Create: `src/core/sources/codex.ts`
- Create: `src/core/sources/index.ts`
- Test: `src/core/sources/claude.test.ts`
- Test: `src/core/sources/codex.test.ts`
- Test: `src/core/sources/index.test.ts`

- [ ] **Step 1: Write failing source type and parser tests**

Create `src/core/sources/claude.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { parseClaudeJsonl } from './claude.js';

describe('parseClaudeJsonl', () => {
  test('parses user and assistant messages into exchanges', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:00.000Z', sessionId: 's1', cwd: '/repo', gitBranch: 'main', message: { role: 'user', content: 'How do we sync?' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:01.000Z', sessionId: 's1', cwd: '/repo', gitBranch: 'main', message: { role: 'assistant', content: [{ type: 'text', text: 'Copy transcripts into archive.' }] } }),
    ].join('\n');

    const exchanges = parseClaudeJsonl(jsonl, { archivePath: '/archive/claude-projects/s1.jsonl', sourceKind: 'claude-projects' });

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({
      archivePath: '/archive/claude-projects/s1.jsonl',
      sourceKind: 'claude-projects',
      lineStart: 1,
      lineEnd: 2,
      sessionId: 's1',
      cwd: '/repo',
      gitBranch: 'main',
      userText: 'How do we sync?',
      assistantText: 'Copy transcripts into archive.',
    });
  });
});
```

Create `src/core/sources/codex.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { parseCodexJsonl } from './codex.js';

describe('parseCodexJsonl', () => {
  test('parses Codex response items into exchanges and tool calls', () => {
    const jsonl = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session', cwd: '/repo', git: { branch: 'main' }, model: 'gpt-5.1', provider: 'openai' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run tests' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"cmd":"bun test"}' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'pass' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests passed.' }] } }),
    ].join('\n');

    const exchanges = parseCodexJsonl(jsonl, { archivePath: '/archive/codex-sessions/rollout.jsonl', sourceKind: 'codex-sessions' });

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].sourceKind).toBe('codex-sessions');
    expect(exchanges[0].sessionId).toBe('codex-session');
    expect(exchanges[0].userText).toBe('Run tests');
    expect(exchanges[0].assistantText).toBe('Tests passed.');
    expect(exchanges[0].toolCalls).toEqual([{ toolName: 'shell', callId: 'call-1', input: '{"cmd":"bun test"}', output: 'pass', status: 'success' }]);
  });
});
```

Create `src/core/sources/index.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { getBuiltInSourceAdapters } from './index.js';

describe('getBuiltInSourceAdapters', () => {
  test('returns stable source kinds for first adapters', () => {
    const kinds = getBuiltInSourceAdapters().map(adapter => adapter.kind);
    expect(kinds).toEqual(['claude-projects', 'claude-transcripts', 'codex-sessions']);
  });
});
```

- [ ] **Step 2: Run parser tests to verify failure**

Run: `bun test src/core/sources`

Expected: FAIL because source modules do not exist.

- [ ] **Step 3: Implement source types**

Create `src/core/sources/types.ts`:

```ts
export interface ToolCallRecord {
  toolName: string | null;
  callId: string | null;
  input: string | null;
  output: string | null;
  status: string | null;
}

export interface ParsedExchange {
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  sourceKind: string;
  sessionId: string | null;
  project: string | null;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  provider: string | null;
  metadataJson: string | null;
  timestamp: number | null;
  userText: string;
  assistantText: string;
  embeddingText: string;
  toolCalls: ToolCallRecord[];
}

export interface ParseContext {
  archivePath: string;
  sourceKind: string;
}

export interface SourceAdapter {
  kind: string;
  roots(): string[];
  detect(filePath: string): boolean;
  parse(content: string, context: ParseContext): ParsedExchange[];
}
```

- [ ] **Step 4: Implement Claude parser**

Create `src/core/sources/claude.ts` with helpers that extract text from string and content blocks, start a new exchange on user messages, accumulate assistant text and tool calls until the next user message, and discard exchanges with no assistant text.

Use this parser signature:

```ts
export function parseClaudeJsonl(content: string, context: ParseContext): ParsedExchange[]
```

Also export adapters:

```ts
export function createClaudeProjectsAdapter(): SourceAdapter
export function createClaudeTranscriptsAdapter(): SourceAdapter
```

The adapters use `CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')` roots and return `projects` or `transcripts` when those directories exist.

- [ ] **Step 5: Implement Codex parser**

Create `src/core/sources/codex.ts` with:

```ts
export function parseCodexJsonl(content: string, context: ParseContext): ParsedExchange[]
export function createCodexSessionsAdapter(): SourceAdapter
```

Handle the test fixture shapes exactly: `session_meta.payload`, `response_item.payload.type = message`, `function_call`, and `function_call_output`. Store extra Codex metadata in `metadataJson` with `JSON.stringify({ source: 'codex' })` if no richer metadata exists.

- [ ] **Step 6: Implement adapter index**

Create `src/core/sources/index.ts`:

```ts
import { createClaudeProjectsAdapter, createClaudeTranscriptsAdapter } from './claude.js';
import { createCodexSessionsAdapter } from './codex.js';
import type { SourceAdapter } from './types.js';

export type { ParsedExchange, ParseContext, SourceAdapter, ToolCallRecord } from './types.js';

export function getBuiltInSourceAdapters(): SourceAdapter[] {
  return [createClaudeProjectsAdapter(), createClaudeTranscriptsAdapter(), createCodexSessionsAdapter()];
}
```

- [ ] **Step 7: Run source tests**

Run: `bun test src/core/sources`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/sources
git commit -m "feat: add transcript source adapters"
```

---

### Task 3: Implement Full-File Archive Indexer

**Files:**
- Create: `src/core/indexer.ts`
- Test: `src/core/indexer.test.ts`
- Modify: `src/core/db.ts`

- [ ] **Step 1: Write failing indexer test**

Create `src/core/indexer.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase } from './db.js';
import { __setModelForTests } from './embeddings.js';
import { reindexArchiveFile } from './indexer.js';
import { parseClaudeJsonl } from './sources/claude.js';

let dir: string | null = null;
let db: ReturnType<typeof initDatabase> | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  __setModelForTests(null, null);
});

describe('reindexArchiveFile', () => {
  test('reindexes a file from scratch and replaces old rows', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, (_, i) => i / 384));

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archivePath = join(dir, 'claude-projects', 'session.jsonl');
    writeFileSync(archivePath, [
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:00.000Z', sessionId: 's1', message: { role: 'user', content: 'First question' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:01.000Z', sessionId: 's1', message: { role: 'assistant', content: 'First answer' } }),
    ].join('\n'));

    await reindexArchiveFile(db, archivePath, 'claude-projects', parseClaudeJsonl);
    await reindexArchiveFile(db, archivePath, 'claude-projects', parseClaudeJsonl);

    const count = db.query('SELECT COUNT(*) AS count FROM exchanges').get() as { count: number };
    const vectorCount = db.query('SELECT COUNT(*) AS count FROM vec_exchanges').get() as { count: number };

    expect(count.count).toBe(1);
    expect(vectorCount.count).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test src/core/indexer.test.ts`

Expected: FAIL because `reindexArchiveFile` is missing.

- [ ] **Step 3: Implement indexer**

Create `src/core/indexer.ts`:

```ts
import { readFileSync } from 'fs';
import type { Database } from 'bun:sqlite';
import { CURRENT_EMBEDDING_VERSION, deleteExchangeIndexForArchivePath, insertExchange, insertToolCall, insertExchangeVector } from './db.js';
import { generateEmbedding } from './embeddings.js';
import type { ParseContext, ParsedExchange } from './sources/types.js';

export type ArchiveParser = (content: string, context: ParseContext) => ParsedExchange[];

export async function reindexArchiveFile(
  db: Database,
  archivePath: string,
  sourceKind: string,
  parser: ArchiveParser,
): Promise<number> {
  const content = readFileSync(archivePath, 'utf-8');
  if (content.includes('DO NOT INDEX THIS CHAT')) {
    deleteExchangeIndexForArchivePath(db, archivePath);
    return 0;
  }

  const exchanges = parser(content, { archivePath, sourceKind });
  deleteExchangeIndexForArchivePath(db, archivePath);

  let indexed = 0;
  for (const exchange of exchanges) {
    const embedding = await generateEmbedding(exchange.embeddingText);
    const exchangeId = insertExchange(db, {
      ...exchange,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    for (const toolCall of exchange.toolCalls) {
      insertToolCall(db, { exchangeId, ...toolCall });
    }

    if (embedding) {
      insertExchangeVector(db, exchangeId, embedding);
    }
    indexed++;
  }

  return indexed;
}
```

Add `insertExchangeVector(db, exchangeId, embedding)` to `src/core/db.ts`.

- [ ] **Step 4: Run indexer test**

Run: `bun test src/core/indexer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/indexer.ts src/core/indexer.test.ts src/core/db.ts
git commit -m "feat: index archived transcript exchanges"
```

---

### Task 4: Replace Sync With Source Adapter Archive Sync

**Files:**
- Modify: `src/cli/sync.ts`
- Test: `src/cli/sync.test.ts`

- [ ] **Step 1: Write failing sync tests**

Replace `src/cli/sync.test.ts` with tests that use temporary roots and archive directories:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase } from '../core/db.js';
import { __setModelForTests } from '../core/embeddings.js';
import { syncTranscripts } from './sync.js';

let dir: string | null = null;
let db: ReturnType<typeof initDatabase> | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.TEST_ARCHIVE_DIR;
  delete process.env.TEST_DB_PATH;
  __setModelForTests(null, null);
});

describe('syncTranscripts', () => {
  test('copies Claude and Codex transcripts under source kind prefixes and indexes them', async () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-sync-'));
    const claudeDir = join(dir, '.claude');
    const codexDir = join(dir, '.codex');
    const archiveDir = join(dir, 'archive');

    mkdirSync(join(claudeDir, 'projects', 'proj'), { recursive: true });
    mkdirSync(join(codexDir, 'sessions'), { recursive: true });

    writeFileSync(join(claudeDir, 'projects', 'proj', 'session.jsonl'), [
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:00.000Z', sessionId: 's1', message: { role: 'user', content: 'Question' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:01.000Z', sessionId: 's1', message: { role: 'assistant', content: 'Answer' } }),
    ].join('\n'));

    writeFileSync(join(codexDir, 'sessions', 'rollout.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'c1', cwd: '/repo' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run tests' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Passed' }] } }),
    ].join('\n'));

    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.CODEX_HOME = codexDir;
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));

    const result = await syncTranscripts(db);

    expect(result.copied).toBe(2);
    expect(result.indexed).toBe(2);
    expect(existsSync(join(archiveDir, 'claude-projects', 'proj', 'session.jsonl'))).toBe(true);
    expect(existsSync(join(archiveDir, 'codex-sessions', 'rollout.jsonl'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test src/cli/sync.test.ts`

Expected: FAIL because current sync only reindexes missing observation embeddings.

- [ ] **Step 3: Implement syncTranscripts**

Rewrite `src/cli/sync.ts` to:

1. get built-in adapters from `getBuiltInSourceAdapters()`;
2. recursively find `.jsonl` files under each adapter root;
3. copy files to `getArchiveDir()/<adapter.kind>/<relative path>` using temp file + rename when destination is missing or older;
4. build a list of archive paths to index when copied or returned by `getArchivePathsNeedingReindex()`;
5. call `reindexArchiveFile()` with the adapter parser.

Export:

```ts
export interface SyncResult {
  copied: number;
  indexed: number;
  skipped: number;
}

export async function syncTranscripts(db: Database): Promise<SyncResult>
```

Keep `runSyncCli()` opening `openDatabase()` and printing `Done. copied=X indexed=Y skipped=Z`.

- [ ] **Step 4: Run sync tests**

Run: `bun test src/cli/sync.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/sync.ts src/cli/sync.test.ts
git commit -m "feat: sync transcript sources"
```

---

### Task 5: Replace Search With Default Hybrid Exchange Search

**Files:**
- Modify: `src/core/search.ts`
- Test: `src/core/search.test.ts`

- [ ] **Step 1: Write failing search tests**

Replace `src/core/search.test.ts` with:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { CURRENT_EMBEDDING_VERSION, initDatabase, insertExchange, insertExchangeVector } from './db.js';
import { __setModelForTests } from './embeddings.js';
import { search } from './search.js';

let db: ReturnType<typeof initDatabase> | null = null;

afterEach(() => {
  db?.close();
  db = null;
  __setModelForTests(null, null);
});

describe('exchange search', () => {
  test('returns vector results and text fallback results without duplicates', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));

    const vectorId = insertExchange(db, {
      archivePath: '/archive/claude-projects/a.jsonl', lineStart: 1, lineEnd: 2, sourceKind: 'claude-projects', sessionId: null, project: 'alpha', cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 26), userText: 'semantic memory', assistantText: 'vector result', embeddingText: 'semantic memory vector result', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertExchangeVector(db, vectorId, Array.from({ length: 384 }, () => 0.1));

    insertExchange(db, {
      archivePath: '/archive/codex-sessions/b.jsonl', lineStart: 3, lineEnd: 4, sourceKind: 'codex-sessions', sessionId: null, project: 'beta', cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 27), userText: 'exact phrase search', assistantText: 'text result', embeddingText: 'exact phrase search text result', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    const results = await search('exact phrase', { db, limit: 10 });

    expect(results.map(result => result.archivePath)).toContain('/archive/codex-sessions/b.jsonl');
    expect(new Set(results.map(result => result.id)).size).toBe(results.length);
  });

  test('filters by source kind and date', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));

    insertExchange(db, {
      archivePath: '/archive/claude-projects/a.jsonl', lineStart: 1, lineEnd: 2, sourceKind: 'claude-projects', sessionId: null, project: null, cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 25), userText: 'filter me', assistantText: 'old', embeddingText: 'filter me old', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
    insertExchange(db, {
      archivePath: '/archive/codex-sessions/b.jsonl', lineStart: 1, lineEnd: 2, sourceKind: 'codex-sessions', sessionId: null, project: null, cwd: null, gitBranch: null, model: null, provider: null, metadataJson: null, timestamp: Date.UTC(2026, 4, 26), userText: 'filter me', assistantText: 'new', embeddingText: 'filter me new', embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });

    const results = await search('filter me', { db, limit: 10, after: '2026-05-26', sourceKind: 'codex-sessions' });

    expect(results).toHaveLength(1);
    expect(results[0].sourceKind).toBe('codex-sessions');
  });
});
```

- [ ] **Step 2: Run search tests to verify failure**

Run: `bun test src/core/search.test.ts`

Expected: FAIL because search still returns observation summaries.

- [ ] **Step 3: Implement exchange search**

Rewrite `src/core/search.ts` with:

```ts
export interface ExchangeSearchResult {
  id: number;
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  sourceKind: string;
  project: string | null;
  timestamp: number | null;
  snippet: string;
  score?: number;
}
```

Implement `search(query, { db, limit, after, before, sourceKind })` as default hybrid:

1. validate date strings;
2. call `generateEmbedding(query)`;
3. if embedding exists, query `vec_exchanges` joined to `exchanges` and order by distance;
4. query text matches with `user_text LIKE ? OR assistant_text LIKE ?` ordered by timestamp desc;
5. append text results not already returned;
6. return at most `limit`.

Use bound SQL parameters for every filter.

- [ ] **Step 4: Run search tests**

Run: `bun test src/core/search.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/search.ts src/core/search.test.ts
git commit -m "feat: search transcript exchanges"
```

---

### Task 6: Replace CLI With sync/search/read Commands

**Files:**
- Create: `src/cli/search.ts`
- Create: `src/cli/read.ts`
- Modify: `src/cli/main.ts`
- Test: `src/cli/main.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Replace `src/cli/main.test.ts` with command parsing tests that call exported helpers instead of spawning a full process:

```ts
import { describe, expect, test } from 'bun:test';
import { parseSearchArgs, parseReadArgs } from './main.js';

describe('CLI argument parsing', () => {
  test('parses search args', () => {
    expect(parseSearchArgs(['search', 'semantic memory', '--after', '2026-05-01', '--source-kind', 'codex-sessions', '--limit', '5'])).toEqual({
      query: 'semantic memory',
      after: '2026-05-01',
      before: undefined,
      sourceKind: 'codex-sessions',
      limit: 5,
    });
  });

  test('parses read args', () => {
    expect(parseReadArgs(['read', '/archive/session.jsonl', '--start-line', '3', '--end-line', '8'])).toEqual({
      path: '/archive/session.jsonl',
      startLine: 3,
      endLine: 8,
    });
  });
});
```

- [ ] **Step 2: Run CLI tests to verify failure**

Run: `bun test src/cli/main.test.ts`

Expected: FAIL because `parseSearchArgs` and `parseReadArgs` do not exist.

- [ ] **Step 3: Implement CLI commands**

Create `src/cli/search.ts`:

```ts
import { openDatabase } from '../core/db.js';
import { search } from '../core/search.js';

export async function runSearchCli(args: { query: string; limit?: number; after?: string; before?: string; sourceKind?: string }): Promise<void> {
  const db = openDatabase();
  try {
    const results = await search(args.query, { db, limit: args.limit, after: args.after, before: args.before, sourceKind: args.sourceKind });
    for (const result of results) {
      const date = result.timestamp ? new Date(result.timestamp).toISOString().split('T')[0] : 'unknown-date';
      console.log(`## [${result.sourceKind}, ${date}] ${result.project ?? 'unknown-project'}`);
      console.log(`${result.snippet}`);
      console.log(`Path: ${result.archivePath}:${result.lineStart}-${result.lineEnd}`);
      if (result.score !== undefined) console.log(`Score: ${Math.round(result.score * 100)}%`);
      console.log('');
    }
  } finally {
    db.close();
  }
}
```

Create `src/cli/read.ts`:

```ts
import { readConversation } from '../core/read.js';

export function runReadCli(args: { path: string; startLine?: number; endLine?: number }): void {
  const output = readConversation(args.path, args.startLine, args.endLine);
  if (output === null) {
    console.error(`File not found: ${args.path}`);
    process.exit(1);
  }
  console.log(output);
}
```

Rewrite `src/cli/main.ts` to import `runSyncCli`, `runSearchCli`, and `runReadCli`, export `parseSearchArgs` and `parseReadArgs`, and route only `sync`, `search`, and `read`.

- [ ] **Step 4: Run CLI tests**

Run: `bun test src/cli/main.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.ts src/cli/search.ts src/cli/read.ts src/cli/main.test.ts
git commit -m "feat: add transcript CLI commands"
```

---

### Task 7: Replace MCP Search/Read Surface

**Files:**
- Modify: `src/mcp/schemas.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/handlers.ts`
- Modify: `src/mcp/server.ts`
- Test: `src/mcp/schemas.test.ts`
- Test: `src/mcp/handlers.test.ts`
- Test: `src/mcp/server.handler.test.ts`

- [ ] **Step 1: Write failing MCP schema tests**

Replace `src/mcp/schemas.test.ts` with:

```ts
import { describe, expect, test } from 'bun:test';
import { SearchInputSchema, ReadInputSchema } from './schemas.js';

describe('MCP schemas', () => {
  test('validates transcript search input', () => {
    expect(SearchInputSchema.parse({ query: 'memory search', limit: 5, source_kind: 'claude-projects' })).toEqual({
      query: 'memory search',
      limit: 5,
      source_kind: 'claude-projects',
    });
  });

  test('validates read input', () => {
    expect(ReadInputSchema.parse({ path: '/archive/session.jsonl', startLine: 1, endLine: 3 })).toEqual({
      path: '/archive/session.jsonl',
      startLine: 1,
      endLine: 3,
    });
  });
});
```

- [ ] **Step 2: Run MCP tests to verify failure**

Run: `bun test src/mcp/schemas.test.ts src/mcp/handlers.test.ts src/mcp/server.handler.test.ts`

Expected: FAIL because schemas and handlers still expose observations.

- [ ] **Step 3: Implement schemas and tools**

Rewrite `src/mcp/schemas.ts` to include only:

```ts
export const SearchInputSchema = z.object({
  query: z.string().min(2),
  limit: z.number().int().min(1).max(50).default(10),
  after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source_kind: z.string().min(1).optional(),
}).strict();

export const ReadInputSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
}).strict();
```

Rewrite `src/mcp/tools.ts` so `allTools = [searchTool, readTool]` and remove `getObservationsTool`.

- [ ] **Step 4: Implement handlers and server routing**

Rewrite `src/mcp/handlers.ts` so:

```ts
export async function handleSearch(params: SearchInput, db: Database): Promise<SearchResult[]> {
  const results = await search(params.query, {
    db,
    limit: params.limit,
    after: params.after,
    before: params.before,
    sourceKind: params.source_kind,
  });
  return results.map(result => ({
    id: String(result.id),
    archive_path: result.archivePath,
    line_start: result.lineStart,
    line_end: result.lineEnd,
    source_kind: result.sourceKind,
    project: result.project,
    timestamp: result.timestamp,
    snippet: result.snippet,
    score: result.score,
  }));
}
```

Update `src/mcp/server.ts` to remove all `get_observations` imports and routing.

- [ ] **Step 5: Run MCP tests**

Run: `bun test src/mcp/schemas.test.ts src/mcp/handlers.test.ts src/mcp/server.handler.test.ts src/mcp/server.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/schemas.ts src/mcp/tools.ts src/mcp/handlers.ts src/mcp/server.ts src/mcp/*.test.ts
git commit -m "feat: expose transcript MCP tools"
```

---

### Task 8: Remove Old Observation Hook Flow

**Files:**
- Delete or stop exporting: `src/cli/record.ts`, `src/cli/extract.ts`, `src/cli/recall.ts`
- Delete or replace tests: `src/cli/record.test.ts`, `src/cli/record.integration.test.ts`, `src/cli/extract.test.ts`, `src/cli/recall.test.ts`
- Modify: `hooks/hooks.json`
- Modify: `README.md`

- [ ] **Step 1: Write failing hook config expectation test**

If `src/cli/main.test.ts` does not already assert help text, add:

```ts
test('help text mentions only transcript commands', () => {
  const help = getHelpText();
  expect(help).toContain('sync');
  expect(help).toContain('search');
  expect(help).toContain('read');
  expect(help).not.toContain('record');
  expect(help).not.toContain('extract');
  expect(help).not.toContain('recall');
});
```

- [ ] **Step 2: Run targeted tests to verify failure**

Run: `bun test src/cli/main.test.ts`

Expected: FAIL until `getHelpText()` and help text are updated.

- [ ] **Step 3: Remove old flow from CLI and hooks**

Remove old command routing from `src/cli/main.ts`. Delete tests that only cover `record`, `extract`, and `recall`. Update `hooks/hooks.json` so the only automated indexing hook runs `memmem sync` if hook installation remains in scope for this repo's config.

- [ ] **Step 4: Update README command docs**

In `README.md`, replace hook-driven observation language with the new commands:

```md
memmem sync
memmem search "query"
memmem read /path/to/archive.jsonl --start-line 1 --end-line 20
```

Mention that this release is a breaking local index change and users should delete the old database before rebuilding.

- [ ] **Step 5: Run old-flow cleanup tests**

Run: `bun test src/cli/main.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/main.ts hooks/hooks.json README.md src/cli/*.test.ts
git rm src/cli/record.ts src/cli/extract.ts src/cli/recall.ts src/cli/record.test.ts src/cli/record.integration.test.ts src/cli/extract.test.ts src/cli/recall.test.ts
git commit -m "refactor: remove observation hook flow"
```

---

### Task 9: Final Integration Verification

**Files:**
- Modify if needed: `package.json`, `scripts/build.mjs`, tests touched by previous tasks.

- [ ] **Step 1: Run typecheck**

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run: `bun test`

Expected: PASS.

- [ ] **Step 3: Run build**

Run: `bun run build`

Expected: PASS and `dist/` artifacts update if this project writes build output.

- [ ] **Step 4: Run a smoke sync/search/read flow with temp config**

Run:

```bash
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/claude/projects/proj"
printf '%s\n%s\n' \
  '{"type":"user","timestamp":"2026-05-26T00:00:00.000Z","sessionId":"smoke","message":{"role":"user","content":"How do we smoke test memmem?"}}' \
  '{"type":"assistant","timestamp":"2026-05-26T00:00:01.000Z","sessionId":"smoke","message":{"role":"assistant","content":"Run sync search and read."}}' \
  > "$TMPDIR/claude/projects/proj/smoke.jsonl"
CONVERSATION_MEMORY_CONFIG_DIR="$TMPDIR/config" CLAUDE_CONFIG_DIR="$TMPDIR/claude" bun dist/cli.mjs sync
CONVERSATION_MEMORY_CONFIG_DIR="$TMPDIR/config" bun dist/cli.mjs search "smoke test"
CONVERSATION_MEMORY_CONFIG_DIR="$TMPDIR/config" bun dist/cli.mjs read "$TMPDIR/config/conversation-archive/claude-projects/proj/smoke.jsonl" --start-line 1 --end-line 2
```

Expected: sync reports at least one indexed exchange, search prints the smoke exchange archive path, read prints the two transcript messages.

- [ ] **Step 5: Commit final fixes if any**

If verification required changes:

```bash
git add <changed-files>
git commit -m "fix: complete transcript memory integration"
```

If no changes were required, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Source adapters: Tasks 2 and 4.
- Claude Code and Codex built-ins: Tasks 2 and 4.
- Archive source of truth and `<kind>/<relative path>` paths: Task 4.
- Exchange schema, tool calls, vectors, embedding version: Tasks 1 and 3.
- Full-file reindex: Task 3.
- Default hybrid search and filters: Task 5.
- CLI sync/search/read: Tasks 4 and 6.
- MCP search/read only: Task 7.
- Old observation flow removal: Task 8.
- Build/test verification: Task 9.

Placeholder scan: no placeholder work items are intentionally left inside the task steps. Items marked out of scope are explicitly excluded from this implementation plan.

Type consistency: the plan consistently uses `sourceKind` in TypeScript, `source_kind` in MCP inputs, `archivePath` in TypeScript, and `archive_path` in MCP outputs.
