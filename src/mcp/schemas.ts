import { z } from 'zod';

export const SearchInputSchema = z.object({
  query: z.string().min(2),
  limit: z.number().int().min(1).max(50).default(10),
  after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();

export const FetchInputSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]),
}).strict();

export type SearchInput = z.infer<typeof SearchInputSchema>;
export type FetchInput = z.infer<typeof FetchInputSchema>;
