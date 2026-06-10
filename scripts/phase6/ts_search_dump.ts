// Dumps full-precision (id, score) JSON for a query against the DB at
// CONVERSATION_MEMORY_DB_PATH, so TS and Go scores can be diffed beyond the
// 2-decimal `Score: NN%` CLI rounding. Args: the query string(s).
import { openDatabase } from "../../src/core/db.ts";
import { search } from "../../src/core/search.ts";

const query = process.argv.slice(2).join(" ");
const db = openDatabase();
try {
  const results = await search(query, { db });
  const out = results.map((r) => ({ id: r.id, score: r.score ?? null }));
  console.log(JSON.stringify(out));
} finally {
  db.close();
}
