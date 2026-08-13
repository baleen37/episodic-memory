import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ParseContext, SourceAdapter, TranscriptSpan } from './types.js';
import { asObject, asString, eachJsonLine, parseTimestamp } from './jsonl.js';
import type { Message } from '../memory/prompts.js';

interface PendingClaudeSpan {
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  sourceKind: string;
  observedAt: number | null;
  userText: string;
  assistantTexts: string[];
}

export function parseClaudeJsonl(content: string, context: ParseContext): TranscriptSpan[] {
  const spans: TranscriptSpan[] = [];
  let current: PendingClaudeSpan | null = null;

  const flushCurrent = () => {
    if (!current) return;

    const assistantText = current.assistantTexts.join('\n');
    const text = formatSpanText(current.userText, assistantText);
    if (text.trim()) {
      const messages: Message[] = [];
      if (current.userText.trim()) messages.push({ role: 'user', content: current.userText.trim() });
      if (assistantText.trim()) messages.push({ role: 'assistant', content: assistantText.trim() });

      spans.push({
        archivePath: current.archivePath,
        lineStart: current.lineStart,
        lineEnd: current.lineEnd,
        sourceKind: current.sourceKind,
        observedAt: current.observedAt,
        text,
        messages,
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
        observedAt: parseTimestamp(item.timestamp),
        userText,
        assistantTexts: [],
      };
      return;
    }

    if (!current) return;

    current.lineEnd = lineNumber;
    current.observedAt ??= parseTimestamp(item.timestamp);

    if (role === 'assistant') {
      const text = extractText(messageContent).trim();
      if (text) current.assistantTexts.push(text);
    }
  });

  flushCurrent();
  return spans;
}

export function createClaudeProjectsAdapter(): SourceAdapter {
  return createClaudeAdapter('claude-code-projects', 'projects');
}

export function createClaudeTranscriptsAdapter(): SourceAdapter {
  return createClaudeAdapter('claude-code-transcripts', 'transcripts');
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
