import { embedPassage, embedQuery } from "../../src/core/embeddings.ts";
const p = await embedPassage("the archive is the source of truth");
const q = await embedQuery("source of truth");
console.error("passage dim", p?.length, "first3", p?.slice(0,3));
console.error("query dim", q?.length, "first3", q?.slice(0,3));
