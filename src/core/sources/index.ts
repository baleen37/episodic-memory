import { createClaudeProjectsAdapter, createClaudeTranscriptsAdapter } from './claude.js';
import { createCodexSessionsAdapter } from './codex.js';
import type { SourceAdapter } from './types.js';

export type { ParseContext, SourceAdapter, TranscriptSpan } from './types.js';

export function getBuiltInSourceAdapters(): SourceAdapter[] {
  return [createClaudeProjectsAdapter(), createClaudeTranscriptsAdapter(), createCodexSessionsAdapter()];
}
