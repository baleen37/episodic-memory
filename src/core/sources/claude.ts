import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ParseContext, SourceAdapter, TranscriptSpan } from './types.js';
import { asObject, asString, eachJsonLine, parseTimestamp } from './jsonl.js';

interface PendingClaudeSpan {
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
  userText: string;
  assistantTexts: string[];
}

export function parseClaudeJsonl(content: string, context: ParseContext): TranscriptSpan[] {
  const spans: TranscriptSpan[] = [];
  let current: PendingClaudeSpan | null = null;

  const flushCurrent = () => {
    if (!current) return;

    const text = formatSpanText(current.userText, current.assistantTexts.join('\n'));
    if (text.trim()) {
      spans.push({
        archivePath: current.archivePath,
        lineStart: current.lineStart,
        lineEnd: current.lineEnd,
        sourceKind: current.sourceKind,
        sessionId: current.sessionId,
        project: current.project,
        cwd: current.cwd,
        gitBranch: current.gitBranch,
        model: current.model,
        provider: current.provider,
        metadataJson: current.metadataJson,
        observedAt: current.observedAt,
        text,
      });
    }
    current = null;
  };

  eachJsonLine(content, (item, lineNumber) => {
    const message = asObject(item.message);
    const role = asString(message?.role) ?? asString(item.type);
    const messageContent = message && 'content' in message ? message.content : undefined;

    if (role === 'user') {
      if (isToolResultContent(messageContent)) {
        if (current) current.lineEnd = lineNumber;
        return;
      }

      flushCurrent();
      const userText = extractText(messageContent).trim();
      current = {
        archivePath: context.archivePath,
        lineStart: lineNumber,
        lineEnd: lineNumber,
        sourceKind: context.sourceKind,
        sessionId: asString(item.sessionId),
        project: null,
        cwd: asString(item.cwd),
        gitBranch: asString(item.gitBranch),
        model: asString(item.model),
        provider: asString(item.provider),
        metadataJson: null,
        observedAt: parseTimestamp(item.timestamp),
        userText,
        assistantTexts: [],
      };
      return;
    }

    if (!current) return;

    current.lineEnd = lineNumber;
    current.sessionId ??= asString(item.sessionId);
    current.cwd ??= asString(item.cwd);
    current.gitBranch ??= asString(item.gitBranch);
    current.model ??= asString(item.model);
    current.provider ??= asString(item.provider);
    current.observedAt ??= parseTimestamp(item.timestamp);

    if (role === 'assistant') {
      current.model ??= asString(message?.model);
      const text = extractText(messageContent).trim();
      if (text) current.assistantTexts.push(text);
    }
  });

  flushCurrent();
  return spans;
}

export function createClaudeProjectsAdapter(): SourceAdapter {
  return createClaudeAdapter('claude-projects', 'projects');
}

export function createClaudeTranscriptsAdapter(): SourceAdapter {
  return createClaudeAdapter('claude-transcripts', 'transcripts');
}

function createClaudeAdapter(kind: string, dirname: string): SourceAdapter {
  return {
    kind,
    roots() {
      const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), dirname);
      return existsSync(root) ? [root] : [];
    },
    detect(filePath: string) {
      return filePath.endsWith('.jsonl');
    },
    parse: parseClaudeJsonl,
  };
}

function formatSpanText(userText: string, assistantText: string): string {
  const parts: string[] = [];
  if (userText.trim()) parts.push(`User: ${userText.trim()}`);
  if (assistantText.trim()) parts.push(`Assistant: ${assistantText.trim()}`);
  return parts.join('\n');
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';

  return value
    .map(block => {
      const object = asObject(block);
      if (!object) return '';
      if (typeof object.text === 'string') return object.text;
      if (typeof object.content === 'string') return object.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function isToolResultContent(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some(block => asObject(block)?.type === 'tool_result');
}
