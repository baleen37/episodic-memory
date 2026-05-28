import { readFileSync } from 'fs';
import type { Database } from 'bun:sqlite';
import { CURRENT_EMBEDDING_VERSION, deleteExchangeIndexForArchivePath, insertExchange, insertToolCall, insertExchangeVector } from './db.js';
import { embedPassage } from './embeddings.js';
import type { ParseContext, ParsedExchange } from './sources/types.js';

export type ArchiveParser = (content: string, context: ParseContext) => ParsedExchange[];

export const EXCLUSION_MARKERS = [
  'DO NOT INDEX THIS CHAT',
  'DO NOT INDEX THIS CONVERSATION',
  '이 대화는 인덱싱하지 마세요',
  '이 대화는 검색에서 제외하세요',
];

export function hasExclusionMarker(content: string): boolean {
  return EXCLUSION_MARKERS.some(marker => content.includes(marker));
}

export async function reindexArchiveFile(
  db: Database,
  archivePath: string,
  sourceKind: string,
  parser: ArchiveParser,
): Promise<number> {
  const content = readFileSync(archivePath, 'utf-8');
  if (hasExclusionMarker(content)) {
    deleteExchangeIndexForArchivePath(db, archivePath);
    return 0;
  }

  const exchanges = parser(content, { archivePath, sourceKind });
  const embeddings: Array<number[] | null> = [];
  for (const exchange of exchanges) {
    embeddings.push(await embedPassage(exchange.embeddingText));
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
