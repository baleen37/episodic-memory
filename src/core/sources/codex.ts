import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ParsedExchange, ParseContext, SourceAdapter, ToolCallRecord } from './types.js';
import { asObject, asString, attachToolResult, eachJsonLine, parseTimestamp, stringifyValue } from './jsonl.js';

interface CodexMeta {
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  provider: string | null;
}

interface PendingCodexExchange extends CodexMeta {
  lineStart: number;
  lineEnd: number;
  timestamp: number | null;
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
        sessionId: current.sessionId,
        project: null,
        cwd: current.cwd,
        gitBranch: current.gitBranch,
        model: current.model,
        provider: current.provider,
        metadataJson: JSON.stringify({ source: 'codex' }),
        timestamp: current.timestamp,
        userText: current.userText,
        assistantText,
        embeddingText: [current.userText, assistantText].filter(Boolean).join('\n'),
        toolCalls: current.toolCalls,
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
        meta.provider = asString(payload.provider) ?? asString(payload.model_provider);
      }
      return;
    }

    if (item.type === 'turn_context') {
      const payload = asObject(item.payload);
      if (payload) {
        meta.cwd = asString(payload.cwd) ?? meta.cwd;
        meta.model = asString(payload.model) ?? meta.model;
        meta.provider = asString(payload.provider) ?? asString(payload.model_provider) ?? meta.provider;
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
          provider: meta.provider,
          timestamp: parseTimestamp(item.timestamp),
          userText: extractText(payload.content).trim(),
          assistantTexts: [],
          toolCalls: [],
        };
        return;
      }

      if (role === 'assistant' && current) {
        current.lineEnd = lineNumber;
        current.timestamp ??= parseTimestamp(item.timestamp);
        const text = extractText(payload.content).trim();
        if (text) current.assistantTexts.push(text);
      }
      return;
    }

    if (!current) return;
    current.lineEnd = lineNumber;
    current.timestamp ??= parseTimestamp(item.timestamp);

    if (isToolCallType(payload.type)) {
      current.toolCalls.push({
        toolName: asString(payload.name) ?? asString(payload.toolName) ?? asString(payload.type),
        callId: asString(payload.call_id) ?? asString(payload.id),
        input: stringifyValue(payload.arguments ?? payload.input ?? payload.action ?? payload.query),
        output: null,
        status: null,
      });
      return;
    }

    if (isToolOutputType(payload.type)) {
      attachToolResult(current.toolCalls, {
        callId: asString(payload.call_id) ?? asString(payload.id),
        output: stringifyValue(payload.output),
        status: 'success',
      });
    }
  });

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

function isToolCallType(value: unknown): boolean {
  return value === 'function_call' || value === 'custom_tool_call' || value === 'tool_search_call' || value === 'local_shell_call';
}

function isToolOutputType(value: unknown): boolean {
  return value === 'function_call_output' || value === 'custom_tool_call_output' || value === 'tool_search_call_output' || value === 'local_shell_call_output';
}
