# memmem Refactoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use core:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate redundant layers, unify types, and rename everything to match domain concepts.

**Architecture:** Remove `hooks/` layer by merging into `cli/`; absorb `observations.ts` into `db.ts`; rename `compress` → `summarize`; unify `ObservationResult`/`ObservationData` → `Observation`; extract query normalizer.

**Tech Stack:** Bun, bun:sqlite, sqlite-vec, TypeScript, bun:test

---

## Task 1: `compress.ts` → `summarize.ts`

**Files:**
- Create: `src/core/summarize.ts`
- Create: `src/core/summarize.test.ts`
- Delete: `src/core/compress.ts`
- Delete: `src/core/compress.test.ts`

**Step 1: Copy and rename**

Create `src/core/summarize.ts` — copy of `compress.ts` with:
- `compressToolData` → `summarizeEvent`
- All internal `compress*` helpers keep their names (private, don't matter)
- Update module doc comment to say "summarization" not "compression"

**Step 2: Copy and update test**

Create `src/core/summarize.test.ts` — copy of `compress.test.ts` with:
- All imports: `'./compress.js'` → `'./summarize.js'`
- `compressToolData` → `summarizeEvent`
- Keep all assertions identical (behavior unchanged)

**Step 3: Update all importers**

Files that import from `compress.ts`:
- `src/hooks/post-tool-use.ts` — change import + rename call
- `src/hooks/post-tool-use.test.ts` — change import + rename call

```typescript
// post-tool-use.ts: before
import { compressToolData } from '../core/compress.js';
const compressed = compressToolData(toolName, toolData);

// after
import { summarizeEvent } from '../core/summarize.js';
const summary = summarizeEvent(toolName, toolData);
```

**Step 4: Run tests**

```bash
bun test
```
Expected: all pass

**Step 5: Delete old files**

```bash
rm src/core/compress.ts src/core/compress.test.ts
```

**Step 6: Run tests again**

```bash
bun test
```
Expected: all pass (no references to deleted files)

**Step 7: Commit**

```bash
git add -p
git commit -m "refactor: rename compress → summarize, compressToolData → summarizeEvent"
```

---

## Task 2: DB — rename `compressed` → `summary`, `PendingEvent` → `BufferedEvent`

**Files:**
- Modify: `src/core/db.ts`
- Modify: `src/core/db.test.ts`
- Modify: `src/hooks/post-tool-use.ts`
- Modify: `src/core/llm/batch-extract-prompt.ts` (field rename only)
- Modify: `src/hooks/stop.ts`

**Step 1: Update `db.ts`**

(a) Rename type and field:
```typescript
// before
export interface PendingEvent {
  sessionId: string;
  project: string;
  toolName: string;
  compressed: string;
  timestamp: number;
  createdAt: number;
}

// after
export interface BufferedEvent {
  sessionId: string;
  project: string;
  toolName: string;
  summary: string;
  timestamp: number;
  createdAt: number;
}
```

(b) Add schema migration (after the `content_original` migration block):
```typescript
// Migrate pending_events: rename compressed → summary
const pendingColumns = db.query(`
  SELECT name FROM pragma_table_info('pending_events')
`).all() as Array<{ name: string }>;
const hasCompressed = pendingColumns.some(c => c.name === 'compressed');
if (hasCompressed) {
  db.exec('ALTER TABLE pending_events RENAME COLUMN compressed TO summary');
}
```

(c) Update `CREATE TABLE` DDL (for fresh databases):
```sql
CREATE TABLE pending_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  summary TEXT NOT NULL,          -- was: compressed
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)
```

(d) Update `insertPendingEvent` — field name + SQL:
```typescript
export function insertBufferedEvent(db: Database, event: BufferedEvent): number {
  const result = db.query(`
    INSERT INTO pending_events (session_id, project, tool_name, summary, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(event.sessionId, event.project, event.toolName, event.summary,
         event.timestamp, event.createdAt);
  return result.lastInsertRowid as number;
}
```

(e) Update `getAllPendingEvents` — alias `summary` in SELECT, return type:
```typescript
export function getAllBufferedEvents(
  db: Database,
  sessionId: string
): Array<BufferedEvent & { id: number }> {
  return db.query(`
    SELECT id, session_id as sessionId, project, tool_name as toolName,
           summary, timestamp, created_at as createdAt
    FROM pending_events
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(sessionId) as Array<BufferedEvent & { id: number }>;
}
```

**Step 2: Update `post-tool-use.ts`**

```typescript
import { summarizeEvent } from '../core/summarize.js';
import { insertBufferedEvent, type BufferedEvent } from '../core/db.js';

export function handlePostToolUse(...): void {
  const summary = summarizeEvent(toolName, toolData);
  if (summary === null) return;

  const now = Date.now();
  const event: BufferedEvent = {
    sessionId, project, toolName, summary, timestamp: now, createdAt: now,
  };
  insertBufferedEvent(db, event);
}
```

**Step 3: Update `batch-extract-prompt.ts`**

Rename `CompressedEvent.compressed` → `CompressedEvent.summary` (type rename comes in Task 3, just the field here):
```typescript
export interface CompressedEvent {
  toolName: string;
  summary: string;      // was: compressed
  timestamp: number;
}
```

Update `buildBatchExtractPrompt` to use `event.summary`.

**Step 4: Update `stop.ts`**

```typescript
import { getAllBufferedEvents, type BufferedEvent } from '../core/db.js';
// ...
const allEvents = getAllBufferedEvents(db, sessionId);
// ...
const compressedEvents: CompressedEvent[] = batch.map((event: BufferedEvent & { id: number }) => ({
  toolName: event.toolName,
  summary: event.summary,   // was: compressed: event.compressed
  timestamp: event.timestamp,
}));
```

**Step 5: Update `db.test.ts`**

- Change `'compressed'` column check → `'summary'`
- Change `insertPendingEvent` → `insertBufferedEvent`
- Change `getAllPendingEvents` → `getAllBufferedEvents`
- Change `PendingEvent` type references → `BufferedEvent`
- Change `.compressed` field access → `.summary`

**Step 6: Update `post-tool-use.test.ts`**

- Change `.compressed` → `.summary` in all assertions
- Example: `expect(events[0].compressed).toBe(...)` → `expect(events[0].summary).toBe(...)`

**Step 7: Run tests**

```bash
bun test
```
Expected: all pass

**Step 8: Commit**

```bash
git add -p
git commit -m "refactor: rename pending_events.compressed→summary, PendingEvent→BufferedEvent"
```

---

## Task 3: `batch-extract-prompt.ts` → `extractor.ts`, `CompressedEvent` → `EventSummary`

**Files:**
- Create: `src/core/llm/extractor.ts`
- Create: `src/core/llm/extractor.test.ts`
- Modify: `src/core/llm/index.ts`
- Modify: `src/hooks/stop.ts`
- Delete: `src/core/llm/batch-extract-prompt.ts`
- Delete: `src/core/llm/batch-extract-prompt.test.ts`

**Step 1: Create `extractor.ts`**

Copy of `batch-extract-prompt.ts` with:
- `CompressedEvent` → `EventSummary`
- `extractObservationsFromBatch` → `extractFromBatch` (shorter)
- Update module doc comment

**Step 2: Create `extractor.test.ts`**

Copy of `batch-extract-prompt.test.ts` with updated imports and type names.

**Step 3: Update `index.ts`**

```typescript
// before
export type { CompressedEvent, ExtractedObservation, PreviousObservation } from './batch-extract-prompt.js';
export { buildBatchExtractPrompt, parseBatchExtractResponse, extractObservationsFromBatch } from './batch-extract-prompt.js';

// after
export type { EventSummary, ExtractedObservation, PreviousObservation } from './extractor.js';
export { buildBatchExtractPrompt, parseBatchExtractResponse, extractFromBatch } from './extractor.js';
```

**Step 4: Update `stop.ts`**

```typescript
import type { EventSummary, ExtractedObservation, PreviousObservation } from '../core/llm/index.js';
import { extractFromBatch } from '../core/llm/index.js';
// ...
const eventSummaries: EventSummary[] = batch.map(event => ({
  toolName: event.toolName,
  summary: event.summary,
  timestamp: event.timestamp,
}));
const extracted = await extractFromBatch(provider, eventSummaries, allExtractedObservations);
```

**Step 5: Run tests, delete old files**

```bash
bun test
rm src/core/llm/batch-extract-prompt.ts src/core/llm/batch-extract-prompt.test.ts
bun test
```

**Step 6: Commit**

```bash
git add -p
git commit -m "refactor: rename batch-extract-prompt→extractor, CompressedEvent→EventSummary"
```

---

## Task 4: Merge `observations.ts` into `db.ts`, unify `Observation` type

**Files:**
- Modify: `src/core/db.ts`
- Modify: `src/core/db.test.ts`
- Delete: `src/core/observations.ts`
- Delete: `src/core/observations.test.ts`
- Modify: `src/hooks/stop.ts`
- Modify: `src/hooks/session-start.ts`
- Modify: `src/mcp/handlers.ts`

**Step 1: Rename `ObservationResult` → `Observation` in `db.ts`**

```typescript
// Replace the two types with one:
export interface Observation {
  id: number;
  title: string;
  content: string;
  contentOriginal: string | null;
  project: string;
  sessionId: string | null;
  timestamp: number;
  createdAt: number;
}
```

Remove the `ObservationResult` interface and the write-only `Observation` interface. Update all functions in `db.ts` to use `Observation` as return type.

Also rename `getObservation` → `getObservationById` for clarity:
```typescript
export function getObservationById(db: Database, id: number): Observation | null
```

**Step 2: Add `createObservation` to `db.ts`** (absorbed from observations.ts)

```typescript
import { generateEmbedding, initEmbeddings } from './embeddings.js';

export async function createObservation(
  db: Database,
  title: string,
  content: string,
  project: string,
  sessionId?: string,
  timestamp?: number,
  contentOriginal?: string
): Promise<number> {
  const now = Date.now();
  const observation: Omit<Observation, 'id'> = {
    title,
    content,
    contentOriginal: contentOriginal ?? null,
    project,
    sessionId: sessionId ?? null,
    timestamp: timestamp ?? now,
    createdAt: now,
  };

  await initEmbeddings();
  const embedding = await generateEmbedding(`${title}\n${content}`);

  return insertObservation(db, observation, embedding ?? undefined);
}
```

Note: `insertObservation` takes an `Omit<Observation, 'id'>` now instead of the old write-only `Observation` interface.

**Step 3: Add `getObservationsByIds` to `db.ts`** (absorbed from observations.ts)

```typescript
export function getObservationsByIds(db: Database, ids: number[]): Observation[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.query(`
    SELECT id, title, content, content_original as contentOriginal,
           project, session_id as sessionId, timestamp, created_at as createdAt
    FROM observations WHERE id IN (${placeholders})
    ORDER BY timestamp DESC
  `).all(...ids) as Observation[];
}
```

**Step 4: Rename `searchObservations` → `getRecentObservations`**

This function is used only for recency-based loading in `session-start.ts`. Rename to clarify it's not semantic search:

```typescript
export function getRecentObservations(
  db: Database,
  options: { project?: string; after?: number; limit?: number }
): Observation[]
```

**Step 5: Update `db.test.ts`**

- `ObservationResult` → `Observation`
- `getObservation` → `getObservationById`
- `searchObservations` → `getRecentObservations`

**Step 6: Update importers**

`stop.ts`:
```typescript
import { createObservation } from '../core/db.js';
// Remove: import { create as createObservation } from '../core/observations.js';
```

Also update `StopHookOptions.createObservationFn` type to match new signature:
```typescript
createObservationFn?: typeof createObservation;
```

`session-start.ts`:
```typescript
import { getRecentObservations, type Observation } from '../core/db.js';
// Remove: import { searchObservations, type ObservationResult } from '../core/db.js';
// Update formatObservation parameter type: ObservationResult → Observation
```

`mcp/handlers.ts`:
```typescript
import { getObservationsByIds, type Observation } from '../core/db.js';
// Remove: import { findByIds as getObservationsByIds } from '../core/observations.js';

// ObservationOutput → use Observation directly, OR keep ObservationOutput as a local type
// Update handleGetObservations return type
```

**Step 7: Run tests**

```bash
bun test
```
Expected: all pass

**Step 8: Delete observations files**

```bash
rm src/core/observations.ts src/core/observations.test.ts
bun test
```

**Step 9: Commit**

```bash
git add -p
git commit -m "refactor: merge observations.ts into db.ts, unify Observation type"
```

---

## Task 5: Extract query normalizer → `mcp/normalizer.ts`

**Files:**
- Create: `src/mcp/normalizer.ts`
- Create: `src/mcp/normalizer.test.ts`
- Modify: `src/mcp/handlers.ts`
- Delete: `src/mcp/query-normalizer.test.ts`

**Step 1: Create `src/mcp/normalizer.ts`**

Extract from `handlers.ts`:
```typescript
// src/mcp/normalizer.ts
import type { LLMConfig, LLMProvider } from '../core/llm/index.js';
import { logDebug } from '../core/logger.js';

export type NormalizerConfig = Pick<LLMConfig, 'provider' | 'model' | 'apiKey'>;
export type LoadConfigFn = () => LLMConfig | null;
export type CreateProviderFn = (config: LLMConfig) => Promise<LLMProvider>;

let cachedProvider: LLMProvider | undefined;
let cachedConfigKey: string | null = null;
let inFlightProvider: Promise<LLMProvider | undefined> | null = null;
let inFlightConfigKey: string | null = null;

export function resetNormalizerCache(): void { ... }

function getConfigCacheKey(config: NormalizerConfig): string { ... }

export async function getNormalizerProvider(
  loadConfig: LoadConfigFn,
  createProvider: CreateProviderFn
): Promise<LLMProvider | undefined> { ... }
```

Move the full implementation. Rename:
- `QueryNormalizerConfig` → `NormalizerConfig`
- `getQueryNormalizerProvider` → `getNormalizerProvider`
- `resetQueryNormalizerCache` → `resetNormalizerCache`

**Step 2: Create `src/mcp/normalizer.test.ts`**

Copy of `query-normalizer.test.ts` with updated imports and function names:
```typescript
import { getNormalizerProvider, resetNormalizerCache, type NormalizerConfig } from './normalizer.js';
```

**Step 3: Update `handlers.ts`**

Remove all normalizer logic, import from `normalizer.ts`:
```typescript
import { getNormalizerProvider, type LoadConfigFn, type CreateProviderFn } from './normalizer.js';
export type { LoadConfigFn, CreateProviderFn };  // keep re-exports if server.ts needs them
```

**Step 4: Run tests, delete old test**

```bash
bun test
rm src/mcp/query-normalizer.test.ts
bun test
```

**Step 5: Commit**

```bash
git add -p
git commit -m "refactor: extract query normalizer from handlers.ts → mcp/normalizer.ts"
```

---

## Task 6: Create `cli/recall.ts` (= inject-cli.ts + session-start.ts)

**Files:**
- Create: `src/cli/recall.ts`
- Create: `src/cli/recall.test.ts`
- Modify: `src/cli/main.ts` (will be rename of index-cli.ts in Task 9)

For now, we create the new file and update `index-cli.ts` to import it.

**Step 1: Create `src/cli/recall.ts`**

Combine `inject-cli.ts` and `hooks/session-start.ts`. The result is a single file:

```typescript
#!/usr/bin/env node
/**
 * recall - SessionStart hook: load recent observations into session context.
 */

import { Database } from 'bun:sqlite';
import { openDatabase } from '../core/db.js';
import { getRecentObservations, type Observation } from '../core/db.js';
import { search } from '../core/search.js';

// ── Config ───────────────────────────────────────────────────────────────────

export interface RecallConfig {
  maxObservations: number;
  maxTokens: number;
  recencyDays: number;
  projectOnly: boolean;
}

function getConfig(): RecallConfig {
  return {
    maxObservations: parseInt(process.env.CONVERSATION_MEMORY_MAX_OBSERVATIONS || '10', 10),
    maxTokens: parseInt(process.env.CONVERSATION_MEMORY_MAX_TOKENS || '1000', 10),
    recencyDays: parseInt(process.env.CONVERSATION_MEMORY_RECENCY_DAYS || '7', 10),
    projectOnly: process.env.CONVERSATION_MEMORY_PROJECT_ONLY === 'true',
  };
}

// ── Session input ─────────────────────────────────────────────────────────────

interface SessionStartInput {
  session_id: string;
  transcript_path: string;
  project?: string;
}

function getProject(input: SessionStartInput): string {
  if (input.project) return input.project;
  const match = input.transcript_path.match(/\/projects\/([^\/]+)\//);
  if (match?.[1]) return match[1];
  return process.env.CLAUDE_PROJECT || 'default';
}

// ── Core logic ────────────────────────────────────────────────────────────────

function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface RecallResult {
  markdown: string;
  includedCount: number;
  tokenCount: number;
}

export async function recallContext(
  db: Database,
  project: string,
  config: RecallConfig
): Promise<RecallResult> {
  const { maxObservations, maxTokens, recencyDays, projectOnly } = config;

  const cutoffMs = Date.now() - recencyDays * 24 * 60 * 60 * 1000;
  const observations = getRecentObservations(db, {
    project: projectOnly ? project : undefined,
    after: cutoffMs,
    limit: maxObservations,
  });

  if (observations.length === 0) {
    return { markdown: '', includedCount: 0, tokenCount: 0 };
  }

  const header = `# ${project} recent context (memmem)\n\n`;
  let markdown = header;
  let currentTokens = countTokens(header);
  let includedCount = 0;

  for (const obs of observations) {
    const line = `- ${obs.title}: ${obs.content}`;
    const lineTokens = countTokens(line + '\n');
    if (currentTokens + lineTokens > maxTokens) break;
    markdown += line + '\n';
    currentTokens += lineTokens;
    includedCount++;
  }

  if (includedCount === 0) {
    return { markdown: '', includedCount: 0, tokenCount: 0 };
  }

  return { markdown, includedCount, tokenCount: currentTokens };
}

// ── CLI deps injection (for testing) ─────────────────────────────────────────

export type RecallCliDeps = {
  openDatabase: typeof openDatabase;
  recallContext: typeof recallContext;
};

const defaultDeps: RecallCliDeps = { openDatabase, recallContext };

export async function runRecallMain(
  stdinData: string,
  deps: RecallCliDeps = defaultDeps
): Promise<void> {
  let input: SessionStartInput;
  if (stdinData.trim()) {
    input = JSON.parse(stdinData) as SessionStartInput;
  } else {
    input = { session_id: process.env.CLAUDE_SESSION_ID || 'unknown', transcript_path: '' };
  }

  const project = getProject(input);
  const config = getConfig();
  const db = deps.openDatabase();

  try {
    const result = await deps.recallContext(db, project, config);
    if (result.markdown) console.log(result.markdown);
  } finally {
    db.close();
  }
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  try {
    const stdinData = await readStdin();
    await runRecallMain(stdinData);
  } catch (error) {
    console.error(`[memmem] Error in recall: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function shouldRunAsEntrypoint(): boolean {
  return process.env.VITEST !== 'true' && !(import.meta as any).test;
}

if (shouldRunAsEntrypoint()) main();
```

**Step 2: Create `src/cli/recall.test.ts`**

Combine tests from `inject-cli.test.ts` and `hooks/session-start.test.ts`. Test `recallContext` and `runRecallMain`.

Key test cases from `session-start.test.ts` to port:
- returns empty when no observations
- formats observations as markdown with header
- respects token budget
- filters by project when `projectOnly: true`
- handles `recencyDays` cutoff

Key test cases from `inject-cli.test.ts` to port:
- parses project from transcript_path
- handles empty stdin
- calls `recallContext` with correct args

**Step 3: Run tests**

```bash
bun test src/cli/recall.test.ts
```
Expected: all pass

**Step 4: Commit**

```bash
git add src/cli/recall.ts src/cli/recall.test.ts
git commit -m "refactor: create recall.ts combining inject-cli + session-start"
```

---

## Task 7: Create `cli/record.ts` (= observe-cli PostToolUse + post-tool-use.ts)

**Files:**
- Create: `src/cli/record.ts`
- Create: `src/cli/record.test.ts`
- Create: `src/cli/record.integration.test.ts`

**Step 1: Create `src/cli/record.ts`**

Combine PostToolUse parts of `observe-cli.ts` with `hooks/post-tool-use.ts`:

```typescript
#!/usr/bin/env node
/**
 * record - PostToolUse hook: summarize and buffer tool events.
 */

import { openDatabase } from '../core/db.js';
import { summarizeEvent } from '../core/summarize.js';
import { insertBufferedEvent, type BufferedEvent } from '../core/db.js';

// ── Core logic ────────────────────────────────────────────────────────────────

export function recordEvent(
  db: Database,
  sessionId: string,
  project: string,
  toolName: string,
  toolData: unknown
): void {
  const summary = summarizeEvent(toolName, toolData);
  if (summary === null) return;

  const now = Date.now();
  insertBufferedEvent(db, { sessionId, project, toolName, summary, timestamp: now, createdAt: now });
}

// ── Input parsing ─────────────────────────────────────────────────────────────

interface PostToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  session_id?: string;
}

function mergeToolPayload(input: unknown, response: unknown): Record<string, unknown> {
  return {
    ...((input && typeof input === 'object') ? input : {}),
    ...(typeof response === 'object' && response !== null ? response : {}),
    ...(typeof response !== 'object' ? { result: response } : {}),
  };
}

function getSessionId(stdinId?: string): string {
  return stdinId || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_SESSION || 'unknown';
}

function getProject(): string {
  return process.env.CLAUDE_PROJECT || process.env.CLAUDE_PROJECT_NAME || 'default';
}

// ── CLI deps injection (for testing) ─────────────────────────────────────────

export type RecordCliDeps = {
  openDatabase: typeof openDatabase;
  recordEvent: typeof recordEvent;
};

const defaultDeps: RecordCliDeps = { openDatabase, recordEvent };

export async function runRecord(
  stdinData: string,
  deps: RecordCliDeps = defaultDeps
): Promise<void> {
  if (!stdinData.trim()) return;

  const input = JSON.parse(stdinData) as PostToolUseInput;
  const db = deps.openDatabase();
  try {
    const sessionId = getSessionId(input.session_id);
    const project = getProject();
    const mergedData = mergeToolPayload(input.tool_input, input.tool_response);
    deps.recordEvent(db, sessionId, project, input.tool_name, mergedData);
  } finally {
    db.close();
  }
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  try {
    const stdinData = await readStdin();
    await runRecord(stdinData);
  } catch (error) {
    console.error(`[memmem] Error in record: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(0);  // Silent failure for async hooks
  }
}

function shouldRunAsEntrypoint(): boolean {
  return process.env.VITEST !== 'true' && !(import.meta as any).test;
}

if (shouldRunAsEntrypoint()) main();
```

**Step 2: Create `src/cli/record.test.ts`**

Combine `hooks/post-tool-use.test.ts` and the PostToolUse cases from `cli/observe-cli.test.ts`.

Test `recordEvent` directly (unit tests from `post-tool-use.test.ts`):
- stores summary in `pending_events` with correct fields — use `.summary` (not `.compressed`)
- skips tools that return null from summarize
- handles multiple sessions
- handles unknown tool names

Test `runRecord` (from `observe-cli.test.ts`):
- routes to `recordEvent` with correct parsed values
- handles empty stdin (no-op)
- uses session_id from stdin JSON

Important: assertions should use `.summary` (not `.compressed`) everywhere.

**Step 3: Copy integration test**

Create `src/cli/record.integration.test.ts` from `src/cli/observe-cli.integration.test.ts`:
- Update imports
- Remove `--summarize` path (that's extract now)
- Update `.compressed` → `.summary`

**Step 4: Run tests**

```bash
bun test src/cli/record.test.ts src/cli/record.integration.test.ts
```
Expected: all pass

**Step 5: Commit**

```bash
git add src/cli/record.ts src/cli/record.test.ts src/cli/record.integration.test.ts
git commit -m "refactor: create record.ts combining post-tool-use + observe-cli PostToolUse"
```

---

## Task 8: Create `cli/extract.ts` (= observe-cli Stop + stop.ts)

**Files:**
- Create: `src/cli/extract.ts`
- Create: `src/cli/extract.test.ts`

**Step 1: Create `src/cli/extract.ts`**

Combine Stop parts of `observe-cli.ts` with `hooks/stop.ts`:

```typescript
#!/usr/bin/env node
/**
 * extract - Stop hook: batch LLM extraction from buffered events into observations.
 */

import { Database } from 'bun:sqlite';
import { openDatabase, getAllBufferedEvents, createObservation, type BufferedEvent } from '../core/db.js';
import { extractFromBatch } from '../core/llm/extractor.js';
import type { LLMProvider, EventSummary, ExtractedObservation, PreviousObservation } from '../core/llm/index.js';
import { loadConfig, createProvider } from '../core/llm/index.js';
import { archiveSession } from '../core/archive.js';
import { getArchiveDir } from '../core/paths.js';
import os from 'os';
import path from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_BATCH_SIZE = 15;
const MIN_EVENT_THRESHOLD = 3;

// ── Options ───────────────────────────────────────────────────────────────────

export interface ExtractOptions {
  provider: LLMProvider;
  sessionId: string;
  project: string;
  batchSize?: number;
  projectSlug?: string;
  claudeProjectsDir?: string;
  archiveDir?: string;
  createObservationFn?: typeof createObservation;
}

// ── Core logic ────────────────────────────────────────────────────────────────

export async function extractObservations(db: Database, options: ExtractOptions): Promise<void> {
  const {
    provider, sessionId, project,
    batchSize = DEFAULT_BATCH_SIZE,
    projectSlug,
    claudeProjectsDir,
    archiveDir,
    createObservationFn = createObservation,
  } = options;

  const allEvents = getAllBufferedEvents(db, sessionId);
  if (allEvents.length < MIN_EVENT_THRESHOLD) return;

  const batches = chunk(allEvents, batchSize);
  const previousObservations: PreviousObservation[] = [];

  for (const batch of batches) {
    try {
      const eventSummaries: EventSummary[] = batch.map(e => ({
        toolName: e.toolName,
        summary: e.summary,
        timestamp: e.timestamp,
      }));

      const extracted = await extractFromBatch(provider, eventSummaries, previousObservations);

      for (const obs of extracted) {
        try {
          await createObservationFn(db, obs.title, obs.content, project, sessionId, Date.now(), obs.contentOriginal);
        } catch (error) {
          console.warn(`Failed to store observation: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      previousObservations.push(...extracted);
    } catch (error) {
      console.warn(`Failed to process batch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (projectSlug) {
    try {
      archiveSession({
        sessionId,
        projectSlug,
        claudeProjectsDir: claudeProjectsDir ?? path.join(os.homedir(), '.claude', 'projects'),
        archiveDir: archiveDir ?? getArchiveDir(),
      });
    } catch (error) {
      console.warn(`Failed to archive session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

// ── CLI helpers ───────────────────────────────────────────────────────────────

function getSessionId(stdinId?: string): string {
  return stdinId || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_SESSION || 'unknown';
}

function getProject(): string {
  return process.env.CLAUDE_PROJECT || process.env.CLAUDE_PROJECT_NAME || 'default';
}

function getProjectSlug(): string | undefined {
  const dir = process.env.CLAUDE_PROJECT_DIR;
  return dir ? dir.replace(/[/.]/g, '-') : undefined;
}

// ── CLI deps injection (for testing) ─────────────────────────────────────────

export type ExtractCliDeps = {
  openDatabase: typeof openDatabase;
  extractObservations: typeof extractObservations;
  loadConfig: typeof loadConfig;
  createProvider: typeof createProvider;
};

const defaultDeps: ExtractCliDeps = { openDatabase, extractObservations, loadConfig, createProvider };

export async function runExtract(
  stdinData: string,
  deps: ExtractCliDeps = defaultDeps
): Promise<void> {
  const stdinSessionId = stdinData.trim()
    ? (JSON.parse(stdinData) as { session_id?: string }).session_id
    : undefined;

  const db = deps.openDatabase();
  try {
    const sessionId = getSessionId(stdinSessionId);
    const project = getProject();
    const config = deps.loadConfig();

    if (!config) {
      console.error('[memmem] No LLM config found, skipping observation extraction');
      return;
    }

    const provider = await deps.createProvider(config);
    await deps.extractObservations(db, {
      provider, sessionId, project, projectSlug: getProjectSlug(),
    });
  } finally {
    db.close();
  }
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  try {
    const stdinData = await readStdin();
    await runExtract(stdinData);
  } catch (error) {
    console.error(`[memmem] Error in extract: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(0);
  }
}

function shouldRunAsEntrypoint(): boolean {
  return process.env.VITEST !== 'true' && !(import.meta as any).test;
}

if (shouldRunAsEntrypoint()) main();
```

**Step 2: Create `src/cli/extract.test.ts`**

Combine `hooks/stop.test.ts` and Stop-related cases from `cli/observe-cli.test.ts`.

Key test cases from `stop.test.ts`:
- skips if fewer than 3 events
- calls LLM for each batch
- stores extracted observations
- handles LLM failure gracefully (continues to next batch)
- archives session if projectSlug provided
- respects batch size
- passes previous observations as context

Key test cases from `observe-cli.test.ts` (Stop path):
- `runExtract` calls `extractObservations` with correct args
- `runExtract` skips if no config
- gets session_id from stdin JSON

Important: use `event.summary` (not `.compressed`) when creating test events.

**Step 3: Run tests**

```bash
bun test src/cli/extract.test.ts
```
Expected: all pass

**Step 4: Commit**

```bash
git add src/cli/extract.ts src/cli/extract.test.ts
git commit -m "refactor: create extract.ts combining stop + observe-cli Stop"
```

---

## Task 9: Update `cli/main.ts` + `hooks/hooks.json`, delete old files

**Files:**
- Create: `src/cli/main.ts` (renamed from `index-cli.ts`)
- Create: `src/cli/main.test.ts` (renamed from `index-cli.test.ts`)
- Modify: `hooks/hooks.json`
- Delete: `src/cli/index-cli.ts`, `src/cli/index-cli.test.ts`
- Delete: `src/cli/inject-cli.ts`, `src/cli/inject-cli.test.ts`
- Delete: `src/cli/observe-cli.ts`, `src/cli/observe-cli.test.ts`, `src/cli/observe-cli.integration.test.ts`
- Delete: `src/hooks/session-start.ts`, `src/hooks/session-start.test.ts`
- Delete: `src/hooks/post-tool-use.ts`, `src/hooks/post-tool-use.test.ts`
- Delete: `src/hooks/stop.ts`, `src/hooks/stop.test.ts`

**Step 1: Create `src/cli/main.ts`**

```typescript
const command = process.argv[2];

if (!command || command === '--help' || command === '-h') {
  console.log(`
memmem - Persistent conversation memory for Claude Code

USAGE:
  memmem <command>

COMMANDS:
  recall    SessionStart hook — inject recent context into session
  record    PostToolUse hook — buffer tool event
  extract   Stop hook — extract observations from buffered events

ENVIRONMENT VARIABLES:
  CONVERSATION_MEMORY_CONFIG_DIR   Override config directory
  CONVERSATION_MEMORY_DB_PATH      Override database path
  CLAUDE_SESSION_ID                Session ID (set by hooks system)
  CLAUDE_PROJECT                   Project name (set by hooks system)
`);
  process.exit(0);
}

async function main() {
  switch (command) {
    case 'recall':
      await import('./recall.js');
      break;
    case 'record':
      await import('./record.js');
      break;
    case 'extract':
      await import('./extract.js');
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run with --help for usage information.');
      process.exit(1);
  }
}

main();
```

**Step 2: Create `src/cli/main.test.ts`**

Adapt from `index-cli.test.ts` — same tests, updated imports/command names.

**Step 3: Update `hooks/hooks.json`**

```json
{
  "$schema": "../../schemas/hooks-schema.json",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [{ "type": "command", "command": "sh ${CLAUDE_PLUGIN_ROOT}/hooks/run.sh recall", "timeout": 1000 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "sh ${CLAUDE_PLUGIN_ROOT}/hooks/run.sh record", "async": true }]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "sh ${CLAUDE_PLUGIN_ROOT}/hooks/run.sh extract", "async": true }]
      }
    ]
  }
}
```

**Step 4: Run full test suite**

```bash
bun test
```
Expected: all pass

**Step 5: Delete old files**

```bash
rm src/cli/index-cli.ts src/cli/index-cli.test.ts
rm src/cli/inject-cli.ts src/cli/inject-cli.test.ts
rm src/cli/observe-cli.ts src/cli/observe-cli.test.ts src/cli/observe-cli.integration.test.ts
rm src/hooks/session-start.ts src/hooks/session-start.test.ts
rm src/hooks/post-tool-use.ts src/hooks/post-tool-use.test.ts
rm src/hooks/stop.ts src/hooks/stop.test.ts
rmdir src/hooks
```

**Step 6: Run full test suite again**

```bash
bun test
bun run typecheck
```
Expected: all pass, no type errors

**Step 7: Commit**

```bash
git add -p
git commit -m "refactor: rename CLI commands (inject→recall, observe→record, extract), remove hooks/ layer"
```

---

## Task 10: Final type renames across MCP layer

**Files:**
- Modify: `src/mcp/handlers.ts`
- Modify: `src/mcp/handlers.test.ts`
- Modify: `src/mcp/server.handler.test.ts`
- Modify: `src/core/search.ts`
- Modify: `src/core/search.test.ts`

**Step 1: Update `src/core/search.ts`**

Rename `CompactObservationResult` → `ObservationSummary`:
```typescript
export interface ObservationSummary {
  id: number;
  title: string;
  project: string;
  timestamp: number;
}
```
Update all usages within the file and its return types.

**Step 2: Update `src/mcp/handlers.ts`**

- Remove `ObservationOutput` type (use `Observation` from db.ts directly, or keep a local alias)
- Update `handleGetObservations` return type
- Update `formatObservations` parameter type
- `SearchResult` can be kept as-is (MCP output shape differs from DB shape)

```typescript
import { getObservationsByIds, type Observation } from '../core/db.js';

export interface SearchResult {
  id: string;   // string for MCP protocol
  title: string;
  project: string;
  timestamp: number;
}
// ObservationOutput removed — use Observation directly
```

**Step 3: Update `mcp/server.ts`**

Remove backward-compatibility re-exports (they are no longer needed):
```typescript
// Remove these:
export { SearchInputSchema, GetObservationsInputSchema, ReadInputSchema };
export type { SearchInput, GetObservationsInput, ReadInput };
export type { SearchResult, ObservationOutput };
```

**Step 4: Update test files**

- `mcp/handlers.test.ts`: update type references
- `mcp/server.handler.test.ts`: update type references
- `core/search.test.ts`: update `CompactObservationResult` → `ObservationSummary`

**Step 5: Run full test suite**

```bash
bun test
bun run typecheck
```
Expected: all pass, no type errors

**Step 6: Commit**

```bash
git add -p
git commit -m "refactor: rename ObservationOutput, CompactObservationResult→ObservationSummary, clean up re-exports"
```

---

## Final Verification

```bash
bun test
bun run typecheck
bun run build
```

All should pass. Review the diff to confirm:
- `hooks/` directory is gone
- `observations.ts` is gone
- `compress.ts` is gone
- `batch-extract-prompt.ts` is gone
- All types are `Observation`, `ObservationSummary`, `BufferedEvent`, `EventSummary`
- All CLI commands are `recall`, `record`, `extract`
