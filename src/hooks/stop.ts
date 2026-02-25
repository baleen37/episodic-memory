/**
 * Stop Hook - Batch LLM extraction from pending_events.
 *
 * This hook is triggered at session end and:
 * 1. Collects all pending_events for the session
 * 2. Skips if < 3 events (too short to be useful)
 * 3. Groups into batches of 10-20 events (default 15)
 * 4. For each batch, calls Gemini with:
 *    - The compressed event data
 *    - Previous batch's last 3 observations (context, avoids duplication)
 *    - Extraction prompt: produce title + content for each meaningful observation
 *    - LLM may return empty array for low-value batches
 * 5. Stores observations with embeddings using observations.ts
 * 6. Runs async (non-blocking)
 */

import { Database } from 'bun:sqlite';
import type { LLMProvider, EventSummary, PreviousObservation } from '../core/llm/index.js';
import { extractFromBatch } from '../core/llm/index.js';
import { createObservation, getAllBufferedEvents, type BufferedEvent } from '../core/db.js';
import { archiveSession } from '../core/archive.js';
import { getArchiveDir } from '../core/paths.js';
import os from 'os';
import path from 'path';

/**
 * Default batch size for event processing.
 * 10-20 events per batch is optimal for LLM context and processing time.
 */
const DEFAULT_BATCH_SIZE = 15;

/**
 * Minimum number of events required to trigger extraction.
 * Fewer than 3 events is typically not enough context for meaningful observations.
 */
const MIN_EVENT_THRESHOLD = 3;

/**
 * Options for the Stop hook.
 */
export interface StopHookOptions {
  /** LLM provider to use for extraction */
  provider: LLMProvider;
  /** Session ID to extract events for */
  sessionId: string;
  /** Project name */
  project: string;
  /** Optional batch size (defaults to DEFAULT_BATCH_SIZE) */
  batchSize?: number;
  /** Project slug (directory name under ~/.claude/projects/) for archive */
  projectSlug?: string;
  /** Override Claude projects base directory (for testing) */
  claudeProjectsDir?: string;
  /** Override archive destination directory (for testing) */
  archiveDir?: string;
  /** Override observation writer (for testing) */
  createObservationFn?: typeof createObservation;
}

/**
 * Handle Stop hook - extract observations from pending events.
 *
 * This function:
 * 1. Retrieves all pending events for the session
 * 2. Checks if minimum threshold is met
 * 3. Groups events into batches
 * 4. Calls LLM for each batch with previous context
 * 5. Stores extracted observations with embeddings
 *
 * @param db - Database instance
 * @param options - Stop hook options
 */
export async function handleStop(
  db: Database,
  options: StopHookOptions
): Promise<void> {
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

  // Step 1: Collect all pending_events for this session
  const allEvents: Array<BufferedEvent & { id: number }> = getAllBufferedEvents(db, sessionId);

  // Step 2: Skip if < 3 events (too short to be useful)
  if (allEvents.length < MIN_EVENT_THRESHOLD) {
    return;
  }

  // Step 3: Group into batches
  const batches = createBatches(allEvents, batchSize);

  // Track all extracted observations from previous batches for context
  const allExtractedObservations: PreviousObservation[] = [];

  // Step 4: Process each batch
  for (const batch of batches) {
    try {
      // Convert to EventSummary format
      const eventSummaries: EventSummary[] = batch.map((event: BufferedEvent & { id: number }) => ({
        toolName: event.toolName,
        summary: event.summary,
        timestamp: event.timestamp,
      }));

      // Extract observations using LLM with previous observations as context
      const extracted = await extractFromBatch(
        provider,
        eventSummaries,
        allExtractedObservations // Pass all previous observations for deduplication
      );

      // Step 5: Store observations with embeddings
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
          // Log but continue with other observations
          console.warn(`Failed to store observation: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Add extracted observations to context for next batch
      allExtractedObservations.push(...extracted);
    } catch (error) {
      // Log but continue with next batch
      console.warn(`Failed to process batch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Step 6: Archive JSONL to conversation-archive
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

/**
 * Split events into batches of specified size.
 *
 * @param events - Array of events to batch
 * @param batchSize - Size of each batch
 * @returns Array of batches
 */
function createBatches<T>(events: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < events.length; i += batchSize) {
    batches.push(events.slice(i, i + batchSize));
  }
  return batches;
}
