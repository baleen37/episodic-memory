import { z } from 'zod';
import { DEFAULT_SEARCH_LIMIT } from '../core/constants.js';

export const SearchInputSchema = z.object({
  query: z.union([
    z.string().min(1),
    z.array(z.string().min(1)).min(2).max(5),
  ]),
  limit: z.number().int().min(1).max(50).default(DEFAULT_SEARCH_LIMIT),
}).strict();

export type SearchInput = z.infer<typeof SearchInputSchema>;
