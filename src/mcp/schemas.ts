import { z } from 'zod';

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

export type SearchInput = z.infer<typeof SearchInputSchema>;
export type ReadInput = z.infer<typeof ReadInputSchema>;
