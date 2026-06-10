export interface TranscriptSpan {
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  sourceKind: string;
  sessionId: string | null;
  project: string | null;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  provider: string | null;
  metadataJson: string | null;
  observedAt: number | null;
  text: string;
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
