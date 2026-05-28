import { openDatabase } from '../core/db.js';
import { search } from '../core/search.js';

export async function runSearchCli(args: { query: string; limit?: number; after?: string; before?: string; sourceKind?: string }): Promise<void> {
  const db = openDatabase();
  try {
    const results = await search(args.query, { db, limit: args.limit, after: args.after, before: args.before, sourceKind: args.sourceKind });
    for (const result of results) {
      const date = result.timestamp ? new Date(result.timestamp).toISOString().split('T')[0] : 'unknown-date';
      console.log(`## [${result.sourceKind}, ${date}] ${result.project ?? 'unknown-project'}`);
      console.log(`${result.snippet}`);
      console.log(`Path: ${result.archivePath}:${result.lineStart}-${result.lineEnd}`);
      if (result.score !== undefined) console.log(`Score: ${Math.round(result.score * 100)}%`);
      console.log('');
    }
  } finally {
    db.close();
  }
}
