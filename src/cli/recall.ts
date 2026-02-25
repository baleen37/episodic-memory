#!/usr/bin/env node
/**
 * recall - SessionStart hook: load recent observations into session context.
 */

import { Database } from 'bun:sqlite';
import { openDatabase, getRecentObservations } from '../core/db.js';

// ── Config ────────────────────────────────────────────────────────────────────

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
  return process.env.VITEST !== 'true' && !(import.meta as ImportMeta & { test?: boolean }).test;
}

if (shouldRunAsEntrypoint()) main();
