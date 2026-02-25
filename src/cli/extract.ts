#!/usr/bin/env node
/**
 * extract - Stop hook: batch LLM extraction from buffered events into observations.
 */

import { Database } from 'bun:sqlite';
import { openDatabase, getAllBufferedEvents, createObservation, type BufferedEvent } from '../core/db.js';
import { extractFromBatch, loadConfig, createProvider } from '../core/llm/index.js';
import type { LLMProvider, EventSummary, PreviousObservation } from '../core/llm/index.js';
import { archiveSession } from '../core/archive.js';
import { getArchiveDir } from '../core/paths.js';
import os from 'os';
import path from 'path';

const DEFAULT_BATCH_SIZE = 15;
const MIN_EVENT_THRESHOLD = 3;

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

/**
 * Extract observations from buffered events via batch LLM calls.
 *
 * 1. Retrieves all buffered events for the session
 * 2. Skips if < MIN_EVENT_THRESHOLD events
 * 3. Splits into batches and calls LLM with previous observations as context
 * 4. Stores extracted observations with embeddings
 * 5. Archives the session JSONL if projectSlug is provided
 */
export async function extractObservations(db: Database, options: ExtractOptions): Promise<void> {
  const {
    provider,
    sessionId,
    project,
    batchSize = DEFAULT_BATCH_SIZE,
    projectSlug,
    claudeProjectsDir,
    archiveDir,
    createObservationFn = createObservation,
  } = options;

  const allEvents: Array<BufferedEvent & { id: number }> = getAllBufferedEvents(db, sessionId);

  if (allEvents.length < MIN_EVENT_THRESHOLD) {
    return;
  }

  const batches = chunk(allEvents, batchSize);
  const allExtractedObservations: PreviousObservation[] = [];

  for (const batch of batches) {
    try {
      const eventSummaries: EventSummary[] = batch.map((event: BufferedEvent & { id: number }) => ({
        toolName: event.toolName,
        summary: event.summary,
        timestamp: event.timestamp,
      }));

      const extracted = await extractFromBatch(provider, eventSummaries, allExtractedObservations);

      for (const obs of extracted) {
        try {
          await createObservationFn(
            db,
            obs.title,
            obs.content,
            project,
            sessionId,
            Date.now(),
            obs.contentOriginal
          );
        } catch (error) {
          console.warn(`Failed to store observation: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      allExtractedObservations.push(...extracted);
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
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

function getSessionId(stdinId?: string): string {
  return stdinId || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_SESSION || 'unknown';
}

function getProject(): string {
  return process.env.CLAUDE_PROJECT || process.env.CLAUDE_PROJECT_NAME || 'default';
}

function getProjectSlug(): string | undefined {
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (!projectDir) {
    return undefined;
  }
  return projectDir.replace(/[/.]/g, '-');
}

export type ExtractCliDeps = {
  openDatabase: typeof openDatabase;
  extractObservations: typeof extractObservations;
  loadConfig: typeof loadConfig;
  createProvider: typeof createProvider;
};

const defaultDeps: ExtractCliDeps = { openDatabase, extractObservations, loadConfig, createProvider };

export async function runExtract(stdinData: string, deps: ExtractCliDeps = defaultDeps): Promise<void> {
  const db = deps.openDatabase();
  try {
    const stdinSessionId = stdinData.trim()
      ? (JSON.parse(stdinData) as { session_id?: string }).session_id
      : undefined;
    const sessionId = getSessionId(stdinSessionId);
    const project = getProject();
    const config = deps.loadConfig();

    if (!config) {
      console.error('[memmem] No LLM config found, skipping observation extraction');
      return;
    }

    const provider = await deps.createProvider(config);
    await deps.extractObservations(db, {
      provider,
      sessionId,
      project,
      projectSlug: getProjectSlug(),
    });
  } finally {
    db.close();
  }
}

export async function runExtractCli(): Promise<void> {
  try {
    const stdinData = await new Promise<string>((resolve) => {
      let data = '';
      process.stdin.on('data', (chunk) => (data += chunk));
      process.stdin.on('end', () => resolve(data));
    });
    await runExtract(stdinData);
  } catch (error) {
    console.error(`[memmem] Error in extract: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(0);
  }
}
