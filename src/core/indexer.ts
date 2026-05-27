import { readFileSync } from 'fs';
import type { Database } from 'bun:sqlite';
import { CURRENT_EMBEDDING_VERSION, deleteExchangeIndexForArchivePath, insertExchange, insertToolCall, insertExchangeVector } from './db.js';
import { generateEmbedding } from './embeddings.js';
import type { ParseContext, ParsedExchange } from './sources/types.js';

export type ArchiveParser = (content: string, context: ParseContext) => ParsedExchange[];

export async function reindexArchiveFile(
  db: Database,
  archivePath: string,
  sourceKind: string,
  parser: ArchiveParser,
): Promise<number> {
  const content = readFileSync(archivePath, 'utf-8');
  if (content.includes('DO NOT INDEX THIS CHAT')) {
    deleteExchangeIndexForArchivePath(db, archivePath);
    return 0;
  }

  const exchanges = parser(content, { archivePath, sourceKind });
  const embeddings: Array<number[] | null> = [];
  for (const exchange of exchanges) {
    embeddings.push(await generateEmbedding(exchange.embeddingText));
  }

  const replaceIndex = db.transaction(() => {
    deleteExchangeIndexForArchivePath(db, archivePath);

    let indexed = 0;
    for (const [index, exchange] of exchanges.entries()) {
      const exchangeId = insertExchange(db, {
        ...exchange,
        embeddingVersion: CURRENT_EMBEDDING_VERSION,
      });

      for (const toolCall of exchange.toolCalls) {
        insertToolCall(db, { exchangeId, ...toolCall });
      }

      const embedding = embeddings[index];
      if (embedding) {
        insertExchangeVector(db, exchangeId, embedding);
      }
      indexed++;
    }

    return indexed;
  });

  return replaceIndex();
}
