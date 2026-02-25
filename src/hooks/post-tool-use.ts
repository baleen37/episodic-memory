/**
 * PostToolUse Hook - Store compressed tool events in pending_events table.
 *
 * This hook is triggered after every tool use and:
 * 1. Gets compressed tool data using summarize.ts
 * 2. Skips tools that return null (low value tools)
 * 3. Stores in pending_events table with session_id, project, tool_name, compressed, timestamp
 * 4. Runs async (non-blocking)
 */

import { Database } from 'bun:sqlite';
import { summarizeEvent } from '../core/summarize.js';
import { insertBufferedEvent, type BufferedEvent } from '../core/db.js';

/**
 * Handle PostToolUse hook - compress and store tool events.
 *
 * @param db - Database instance
 * @param sessionId - Session ID from environment
 * @param project - Project name
 * @param toolName - Name of the tool that was called
 * @param toolData - Result/output data from the tool call
 */
export function handlePostToolUse(
  db: Database,
  sessionId: string,
  project: string,
  toolName: string,
  toolData: unknown
): void {
  // Step 1: Get summarized tool data
  const summary = summarizeEvent(toolName, toolData);

  // Step 2: Skip if compression returned null (low value tool)
  if (summary === null) {
    return;
  }

  // Step 3: Store in pending_events table
  const now = Date.now();
  const event: BufferedEvent = {
    sessionId,
    project,
    toolName,
    summary,
    timestamp: now,
    createdAt: now,
  };

  insertBufferedEvent(db, event);
}
