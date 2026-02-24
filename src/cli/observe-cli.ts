#!/usr/bin/env node
/**
 * Observe CLI - Handle PostToolUse and Stop hooks for memmem.
 *
 * This script is called by the hooks system and:
 * - For PostToolUse: Compresses and stores tool events in pending_events
 * - For Stop: Batch extracts observations from pending_events using LLM
 */

import { openDatabase } from '../core/db.js';
import { handlePostToolUse } from '../hooks/post-tool-use.js';
import { handleStop } from '../hooks/stop.js';
import { loadConfig, createProvider } from '../core/llm/index.js';
import type { StopHookOptions } from '../hooks/stop.js';

/**
 * PostToolUse hook input from Claude Code.
 * See: https://code.claude.com/docs/en/hooks.md
 */
interface PostToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  session_id?: string;
  tool_use_id?: string;
}

/**
 * Read stdin as JSON.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

/**
 * Get session ID from stdin JSON first, then environment variables.
 * Claude Code injects session_id into the hook stdin JSON payload.
 */
function getSessionId(stdinSessionId?: string): string {
  return stdinSessionId || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_SESSION || 'unknown';
}

/**
 * Get project name from environment.
 */
function getProject(): string {
  return process.env.CLAUDE_PROJECT || process.env.CLAUDE_PROJECT_NAME || 'default';
}

/**
 * Derive the Claude project slug from CLAUDE_PROJECT_DIR.
 * Claude Code injects CLAUDE_PROJECT_DIR into all hook commands.
 * ~/.claude/projects/ directories are named by replacing '/' and '.' with '-' in the path.
 */
function getProjectSlug(): string | undefined {
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (!projectDir) {
    return undefined;
  }
  return projectDir.replace(/[/.]/g, '-');
}

/**
 * Handle PostToolUse hook.
 */
export type ObserveCliDeps = {
  openDatabase: typeof openDatabase;
  handlePostToolUse: typeof handlePostToolUse;
  handleStop: typeof handleStop;
  loadConfig: typeof loadConfig;
  createProvider: typeof createProvider;
};

const defaultDeps: ObserveCliDeps = {
  openDatabase,
  handlePostToolUse,
  handleStop,
  loadConfig,
  createProvider,
};

/**
 * Merge tool_input and tool_response for compression.
 */
function mergeToolPayload(toolInput: unknown, toolResponse: unknown): Record<string, unknown> {
  return {
    ...((toolInput && typeof toolInput === 'object') ? toolInput : {}),
    ...(typeof toolResponse === 'object' && toolResponse !== null ? toolResponse : {}),
    ...(typeof toolResponse !== 'object' ? { result: toolResponse } : {}),
  };
}

/**
 * Handle PostToolUse hook.
 */
export async function runObserve(
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
  stdinSessionId?: string,
  deps: ObserveCliDeps = defaultDeps
): Promise<void> {
  const db = deps.openDatabase();
  try {
    const sessionId = getSessionId(stdinSessionId);
    const project = getProject();
    const mergedData = mergeToolPayload(toolInput, toolResponse);
    deps.handlePostToolUse(db, sessionId, project, toolName, mergedData);
  } finally {
    db.close();
  }
}

/**
 * Handle Stop hook with summarization.
 */
export async function runSummarize(
  stdinSessionId?: string,
  deps: ObserveCliDeps = defaultDeps
): Promise<void> {
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
    const options: StopHookOptions = {
      provider,
      sessionId,
      project,
      projectSlug: getProjectSlug(),
    };

    await deps.handleStop(db, options);
  } finally {
    db.close();
  }
}

export async function runWithStdinData(
  stdinData: string,
  shouldSummarize: boolean,
  deps: ObserveCliDeps = defaultDeps
): Promise<void> {
  if (shouldSummarize) {
    const stdinSessionId = stdinData.trim() ? (JSON.parse(stdinData) as { session_id?: string }).session_id : undefined;
    await runSummarize(stdinSessionId, deps);
    return;
  }

  if (!stdinData.trim()) {
    return;
  }

  const input = JSON.parse(stdinData) as PostToolUseInput;
  await runObserve(input.tool_name, input.tool_input, input.tool_response, input.session_id, deps);
}

export async function main() {
  try {
    const command = process.argv[2];
    const shouldSummarize = command === '--summarize' || process.argv.includes('--summarize');
    const stdinData = await readStdin();
    await runWithStdinData(stdinData, shouldSummarize);
  } catch (error) {
    // Silent failure for async hooks to avoid disrupting session
    console.error(`[memmem] Error in observe: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(0);
  }
}

function shouldRunAsEntrypoint(): boolean {
  return process.env.VITEST !== 'true' && !(import.meta as ImportMeta & { test?: boolean }).test;
}

if (shouldRunAsEntrypoint()) {
  main();
}
