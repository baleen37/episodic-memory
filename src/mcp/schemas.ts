import { z } from 'zod';

export const SearchInputSchema = z.object({
  query: z.union([
    z.string().min(1),
    z.array(z.string().min(1)).min(2).max(5),
  ]),
  limit: z.number().int().min(1).max(50).optional(),
  threshold: z.number().min(0).max(1).optional(),
  explain: z.boolean().optional(),
}).strict();

export type SearchInput = z.infer<typeof SearchInputSchema>;
