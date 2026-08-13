import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ParseContext, SourceAdapter, TranscriptSpan } from './types.js';
import { asObject, asString, eachJsonLine, parseTimestamp } from './jsonl.js';
import type { Message } from '../memory/prompts.js';

interface PendingCodexSpan {
  lineStart: number;
  lineEnd: number;
  observedAt: number | null;
  userText: string;
  assistantTexts: string[];
}

export function parseCodexJsonl(content: string, context: ParseContext): TranscriptSpan[] {
  const spans: TranscriptSpan[] = [];
  let current: PendingCodexSpan | null = null;

  const flushCurrent = () => {
    if (!current) return;

    const assistantText = current.assistantTexts.join('\n');
    const text = formatSpanText(current.userText, assistantText);
    if (text.trim()) {
      const messages: Message[] = [];
      if (current.userText.trim()) messages.push({ role: 'user', content: current.userText.trim() });
      if (assistantText.trim()) messages.push({ role: 'assistant', content: assistantText.trim() });

      spans.push({
        archivePath: context.archivePath,
        lineStart: current.lineStart,
        lineEnd: current.lineEnd,
        sourceKind: context.sourceKind,
        observedAt: current.observedAt,
        text,
        messages,
      });
    }
    current = null;
  };

  eachJsonLine(content, (item, lineNumber) => {
    if (item.type !== 'response_item') return;

    const payload = asObject(item.payload);
    if (!payload) return;

    if (payload.type === 'message') {
      const role = asString(payload.role);
      if (role === 'user') {
        flushCurrent();
        current = {
          lineStart: lineNumber,
          lineEnd: lineNumber,
          observedAt: parseTimestamp(item.timestamp),
          userText: extractText(payload.content).trim(),
          assistantTexts: [],
        };
        return;
      }

      if (role === 'assistant' && current) {
        current.lineEnd = lineNumber;
        current.observedAt ??= parseTimestamp(item.timestamp);
        const text = extractText(payload.content).trim();
        if (text) current.assistantTexts.push(text);
      }
      return;
    }

    if (!current) return;
    current.lineEnd = lineNumber;
    current.observedAt ??= parseTimestamp(item.timestamp);
  });

  flushCurrent();
  return spans;
}

export function createCodexSessionsAdapter(): SourceAdapter {
  return {
    kind: 'codex-sessions',
    roots() {
      const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
      return existsSync(root) ? [root] : [];
    },
    detect(filePath: string) {
      return filePath.endsWith('.jsonl');
    },
    parse: parseCodexJsonl,
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
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
