export interface ToolCallRecord {
  toolName: string | null;
  callId: string | null;
  input: string | null;
  output: string | null;
  status: string | null;
}

export interface ParsedExchange {
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
  timestamp: number | null;
  userText: string;
  assistantText: string;
  embeddingText: string;
  toolCalls: ToolCallRecord[];
}

export interface ParseContext {
  archivePath: string;
  sourceKind: string;
}

export interface SourceAdapter {
  kind: string;
  roots(): string[];
  detect(filePath: string): boolean;
  parse(content: string, context: ParseContext): ParsedExchange[];
}
