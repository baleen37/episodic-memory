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
