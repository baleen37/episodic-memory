import type { LLMProvider } from './types.js';
import { logDebug, logError, logInfo } from '../logger.js';

export interface TranscriptSpanForExtraction {
  sourceKind: string;
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  observedAt: number;
  project?: string;
  text: string;
}

export interface ExtractedMemoryRecord {
  kind: 'fact' | 'event';
  text: string;
  confidence: number;
  dedupeKey?: string;
}

export interface ExtractMemoryOptions {
  maxRecords: number;
  maxTokens?: number;
}

const MEMORY_EXTRACT_SYSTEM_PROMPT = `You extract durable memory records from transcript spans.

Rules:
- Return JSON array only, with no markdown or explanations.
- Extract only fact or event records.
- A fact is a durable preference, decision, requirement, project detail, or technical state worth remembering.
- An event is a durable action, change, incident, or outcome that happened in the transcript.
- Each record must be atomic and independently understandable.
- Return [] when there is no durable memory.
- Do not infer unsupported information.
- Do not summarize the whole conversation.
- Do not include speculative assistant reasoning.
- Keep each text under 240 characters.

Response format:
[
  {"kind":"fact","text":"Memmem stores source-linked fact/event memory records.","confidence":0.9,"dedupeKey":"memmem-memory-records"},
  {"kind":"event","text":"The user asked to replace the observation extractor with a memory-record extractor.","confidence":0.8}
]`;

function stripMarkdownFences(response: string): string {
  let jsonText = response.trim();
  if (!jsonText.startsWith('```')) {
    return jsonText;
  }

  const lines = jsonText.split('\n');
  let startIndex = 0;
  let endIndex = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) {
      startIndex = i + 1;
      break;
    }
  }

  for (let i = startIndex; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n').trim();
}

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildMemoryExtractPrompt(span: TranscriptSpanForExtraction, maxRecords: number): string {
  const project = span.project ? ` project="${escapeAttribute(span.project)}"` : '';

  return `<transcript_span source_kind="${escapeAttribute(span.sourceKind)}" archive_path="${escapeAttribute(span.archivePath)}" lines="${span.lineStart}-${span.lineEnd}" observed_at="${span.observedAt}"${project}>
${span.text}
</transcript_span>

Extract up to ${maxRecords} durable memory records from this transcript span.
Return records as JSON objects with kind "fact" or "event", text, confidence, and optional dedupeKey.
Return [] if the span is low-value or contains no durable memory.
Return only a JSON array.`;
}

export function parseMemoryExtractResponse(response: string, maxRecords: number): ExtractedMemoryRecord[] {
  try {
    const parsed = JSON.parse(stripMarkdownFences(response)) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const records: ExtractedMemoryRecord[] = [];

    for (const item of parsed) {
      if (records.length >= maxRecords) {
        break;
      }
      if (typeof item !== 'object' || item === null) {
        continue;
      }

      const raw = item as Record<string, unknown>;
      if (raw.kind !== 'fact' && raw.kind !== 'event') {
        continue;
      }
      if (typeof raw.text !== 'string') {
        continue;
      }

      const text = normalizeWhitespace(raw.text);
      if (text.length === 0 || text.length > 400) {
        continue;
      }

      const rawDedupeKey = typeof raw.dedupeKey === 'string'
        ? raw.dedupeKey
        : typeof raw.dedupe_key === 'string'
          ? raw.dedupe_key
          : undefined;
      const dedupeKey = rawDedupeKey?.trim();

      records.push({
        kind: raw.kind,
        text,
        confidence: clampConfidence(raw.confidence),
        ...(dedupeKey ? { dedupeKey } : {}),
      });
    }

    return records;
  } catch {
    return [];
  }
}

export async function extractMemoryRecordsFromSpan(
  provider: LLMProvider,
  span: TranscriptSpanForExtraction,
  options: ExtractMemoryOptions,
): Promise<ExtractedMemoryRecord[]> {
  const startTime = Date.now();

  logDebug('extractMemoryRecordsFromSpan: starting memory extraction', {
    sourceKind: span.sourceKind,
    archivePath: span.archivePath,
    lineStart: span.lineStart,
    lineEnd: span.lineEnd,
    maxRecords: options.maxRecords,
  });

  try {
    const prompt = buildMemoryExtractPrompt(span, options.maxRecords);
    const result = await provider.complete(prompt, {
      systemPrompt: MEMORY_EXTRACT_SYSTEM_PROMPT,
      maxTokens: options.maxTokens ?? 1500,
    });
    const records = parseMemoryExtractResponse(result.text, options.maxRecords);
    const duration = Date.now() - startTime;

    logInfo('extractMemoryRecordsFromSpan: completed memory extraction', {
      recordCount: records.length,
      responseLength: result.text.length,
      duration: `${duration}ms`,
    });

    return records;
  } catch (error) {
    const duration = Date.now() - startTime;

    logError('extractMemoryRecordsFromSpan: memory extraction failed', error, {
      sourceKind: span.sourceKind,
      archivePath: span.archivePath,
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      duration: `${duration}ms`,
    });

    throw error;
  }
}
