import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ParsedExchange, ParseContext, SourceAdapter, ToolCallRecord } from './types.js';

type JsonObject = Record<string, unknown>;

interface CodexMeta {
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  provider: string | null;
}

interface PendingCodexExchange {
  lineStart: number;
  lineEnd: number;
  userText: string;
  assistantTexts: string[];
  toolCalls: ToolCallRecord[];
}

export function parseCodexJsonl(content: string, context: ParseContext): ParsedExchange[] {
  const exchanges: ParsedExchange[] = [];
  const meta: CodexMeta = { sessionId: null, cwd: null, gitBranch: null, model: null, provider: null };
  let current: PendingCodexExchange | null = null;

  const flushCurrent = () => {
    if (!current) return;

    const assistantText = current.assistantTexts.join('\n').trim();
    if (assistantText) {
      exchanges.push({
        archivePath: context.archivePath,
        lineStart: current.lineStart,
        lineEnd: current.lineEnd,
        sourceKind: context.sourceKind,
        sessionId: meta.sessionId,
        project: null,
        cwd: meta.cwd,
        gitBranch: meta.gitBranch,
        model: meta.model,
        provider: meta.provider,
        metadataJson: JSON.stringify({ source: 'codex' }),
        timestamp: null,
        userText: current.userText,
        assistantText,
        embeddingText: [current.userText, assistantText].filter(Boolean).join('\n'),
        toolCalls: current.toolCalls,
      });
    }
    current = null;
  };

  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;

    const item = parseJsonObject(line);
    if (!item) continue;

    const lineNumber = index + 1;
    if (item.type === 'session_meta') {
      const payload = asObject(item.payload);
      if (payload) {
        meta.sessionId = asString(payload.id);
        meta.cwd = asString(payload.cwd);
        meta.gitBranch = asString(asObject(payload.git)?.branch);
        meta.model = asString(payload.model);
        meta.provider = asString(payload.provider);
      }
      continue;
    }

    if (item.type !== 'response_item') continue;

    const payload = asObject(item.payload);
    if (!payload) continue;

    if (payload.type === 'message') {
      const role = asString(payload.role);
      if (role === 'user') {
        flushCurrent();
        current = {
          lineStart: lineNumber,
          lineEnd: lineNumber,
          userText: extractText(payload.content).trim(),
          assistantTexts: [],
          toolCalls: [],
        };
        continue;
      }

      if (role === 'assistant' && current) {
        current.lineEnd = lineNumber;
        const text = extractText(payload.content).trim();
        if (text) current.assistantTexts.push(text);
      }
      continue;
    }

    if (!current) continue;
    current.lineEnd = lineNumber;

    if (payload.type === 'function_call') {
      current.toolCalls.push({
        toolName: asString(payload.name),
        callId: asString(payload.call_id),
        input: asString(payload.arguments),
        output: null,
        status: null,
      });
      continue;
    }

    if (payload.type === 'function_call_output') {
      const callId = asString(payload.call_id);
      const existing = current.toolCalls.find(call => call.callId === callId && call.output === null);
      const output = stringifyValue(payload.output);
      if (existing) {
        existing.output = output;
        existing.status = 'success';
      } else {
        current.toolCalls.push({ toolName: null, callId, input: null, output, status: 'success' });
      }
    }
  }

  flushCurrent();
  return exchanges;
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

function parseJsonObject(line: string): JsonObject | null {
  try {
    return asObject(JSON.parse(line));
  } catch {
    return null;
  }
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringifyValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
