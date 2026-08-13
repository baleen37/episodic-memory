import { openMemoryDb } from '../core/memory/schema.js';
import { searchMemories } from '../core/memory/search.js';
import { LOCAL_USER_ID } from '../core/constants.js';

export interface SearchCliArgs {
  query: string;
  limit?: number;
  after?: string;
  before?: string;
  sourceKind?: string;
}

export async function runSearchCli(args: SearchCliArgs): Promise<void> {
  if (args.after || args.before) {
    throw new Error('--after/--before are not yet supported in the mem0 v2 surface');
  }

  const db = openMemoryDb();
  try {
    const filters: Record<string, string> = { user_id: LOCAL_USER_ID };
    if (args.sourceKind) filters.agent_id = args.sourceKind;

    const { results } = await searchMemories({
      db,
      query: args.query,
      filters,
      limit: args.limit,
    });
    for (const result of results) {
      console.log(`## ${result.memory}`);
      console.log(`Score: ${Math.round(result.score * 100)}%`);
      console.log('');
    }
  } finally {
    db.close();
  }
}
