import type { Message } from '../memory/prompts.js';

export interface TranscriptSpan {
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  sourceKind: string;
  observedAt: number | null;
  text: string;
  messages: Message[];
}

export interface ParseContext {
  archivePath: string;
  sourceKind: string;
}

export interface SourceAdapter {
  kind: string;
  roots(): string[];
  detect(filePath: string): boolean;
  parse(content: string, context: ParseContext): TranscriptSpan[];
}
