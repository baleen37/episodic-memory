import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ParseContext, SourceAdapter, TranscriptSpan } from './types.js';
import { asObject, asString, eachJsonLine, parseTimestamp } from './jsonl.js';

interface CodexMeta {
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
}

interface PendingCodexSpan extends CodexMeta {
  lineStart: number;
  lineEnd: number;
  observedAt: number | null;
  userText: string;
  assistantTexts: string[];
}

export function parseCodexJsonl(content: string, context: ParseContext): TranscriptSpan[] {
  const spans: TranscriptSpan[] = [];
  const meta: CodexMeta = { sessionId: null, cwd: null, gitBranch: null, model: null };
  let current: PendingCodexSpan | null = null;

  const flushCurrent = () => {
    if (!current) return;

    const text = formatSpanText(current.userText, current.assistantTexts.join('\n'));
    if (text.trim()) {
      spans.push({
        archivePath: context.archivePath,
        lineStart: current.lineStart,
        lineEnd: current.lineEnd,
        sourceKind: context.sourceKind,
        sessionId: current.sessionId,
        project: null,
        cwd: null,
        gitBranch: null,
        model: current.model,
        provider: 'codex',
        metadataJson: JSON.stringify({ source: 'codex' }),
        observedAt: current.observedAt,
        text,
      });
    }
    current = null;
  };

  eachJsonLine(content, (item, lineNumber) => {
    if (item.type === 'session_meta') {
      const payload = asObject(item.payload);
      if (payload) {
        meta.sessionId = asString(payload.id);
        meta.cwd = asString(payload.cwd);
        meta.gitBranch = asString(asObject(payload.git)?.branch);
        meta.model = asString(payload.model);
      }
      return;
    }

    if (item.type === 'turn_context') {
      const payload = asObject(item.payload);
      if (payload) {
        meta.cwd = asString(payload.cwd) ?? meta.cwd;
        meta.model = asString(payload.model) ?? meta.model;
      }
      return;
    }

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
          sessionId: meta.sessionId,
          cwd: meta.cwd,
          gitBranch: meta.gitBranch,
          model: meta.model,
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
