/**
 * Observations CRUD Operations
 *
 * Simplified observation system with just title + content.
 * Uses db.ts for database operations.
 */

import { Database } from 'bun:sqlite';
import {
  Observation,
  ObservationResult,
  insertObservation,
  getObservation,
  searchObservations
} from './db.js';
import { generateEmbedding, initEmbeddings } from './embeddings.js';

/**
 * Simplified Observation type for public API
 */
export interface ObservationData {
  id: number;
  title: string;
  content: string;
  contentOriginal: string | null;
  project: string;
  sessionId: string | null;
  timestamp: number;
}

/**
 * Create a new observation with embedding.
 *
 * @param db - Database instance
 * @param title - Observation title
 * @param content - Observation content
 * @param project - Project name
 * @param sessionId - Optional session ID
 * @param timestamp - Optional timestamp (defaults to now)
 * @param contentOriginal - Optional original-language/source text
 * @returns The ID of the created observation
 */
export async function create(
  db: Database,
  title: string,
  content: string,
  project: string,
  sessionId?: string,
  timestamp?: number,
  contentOriginal?: string
): Promise<number> {
  const now = Date.now();
  const obsTimestamp = timestamp ?? now;

  const observation: Observation = {
    title,
    content,
    contentOriginal,
    project,
    sessionId,
    timestamp: obsTimestamp,
    createdAt: now
  };

  // Initialize embeddings if not already done
  await initEmbeddings();

  // Generate embedding for the observation content (may be null if disabled)
  // Use title and content for better searchability
  const embeddingText = `${title}\n${content}`;
  const embedding = await generateEmbedding(embeddingText);

  return insertObservation(db, observation, embedding ?? undefined);
}

/**
 * Find a single observation by ID.
 *
 * @param db - Database instance
 * @param id - Observation ID
 * @returns Observation or null if not found
 */
export async function findById(
  db: Database,
  id: number
): Promise<ObservationData | null> {
  const result = getObservation(db, id);

  if (!result) {
    return null;
  }

  return {
    id: result.id,
    title: result.title,
    content: result.content,
    contentOriginal: result.contentOriginal,
    project: result.project,
    sessionId: result.sessionId,
    timestamp: result.timestamp
  };
}

/**
 * Find multiple observations by IDs.
 *
 * @param db - Database instance
 * @param ids - Array of observation IDs
 * @returns Array of observations (empty if none found)
 */
export async function findByIds(
  db: Database,
  ids: number[]
): Promise<ObservationData[]> {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.query(`
    SELECT id, title, content, content_original as contentOriginal, project, session_id as sessionId, timestamp
    FROM observations
    WHERE id IN (${placeholders})
    ORDER BY timestamp DESC
  `);

  const results = stmt.all(...ids) as ObservationResult[];

  return results.map(r => ({
    id: r.id,
    title: r.title,
    content: r.content,
    contentOriginal: r.contentOriginal,
    project: r.project,
    sessionId: r.sessionId,
    timestamp: r.timestamp
  }));
}
