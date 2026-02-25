#!/usr/bin/env node
/**
 * record - PostToolUse hook: compress and buffer tool events.
 */

import { Database } from 'bun:sqlite';
import { openDatabase, insertPendingEvent, type PendingEvent } from '../core/db.js';
import { compressEvent } from '../core/compress.js';

// ── Core logic ────────────────────────────────────────────────────────────────

export function recordEvent(
  db: Database,
  sessionId: string,
  project: string,
  toolName: string,
  toolData: unknown
): void {
  const summary = compressEvent(toolName, toolData);
  if (summary === null) return;

  const now = Date.now();
  const event: PendingEvent = {
    sessionId,
    project,
    toolName,
    summary,
    timestamp: now,
    createdAt: now,
  };
  insertPendingEvent(db, event);
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

export async function runRecordCli(): Promise<void> {
  try {
    const stdinData = await readStdin();
    await runRecord(stdinData);
  } catch (error) {
    console.error(`[memmem] Error in record: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(0);  // Silent failure for async hooks
  }
}
