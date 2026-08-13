import type { LLMProvider } from '../llm/types.js';
import {
  ADDITIVE_EXTRACTION_PROMPT, ENTITY_EXTRACTION_SUFFIX,
  generateAdditiveExtractionPrompt, type PromptArgs,
} from './prompts.js';

/** main.py raises rather than returning [] so callers can tell "LLM down" from "no facts". */
export class LLMError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LLMError';
  }
}

export interface ExtractedEntity {
  type: string | null;
  text: string;
}

export interface ExtractedMemory {
  id: string;
  text: string;
  attributed_to: 'user' | 'assistant';
  linked_memory_ids: string[];
  entities: ExtractedEntity[];
}

function parseEntities(raw: unknown): ExtractedEntity[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedEntity[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.text !== 'string' || row.text.trim() === '') continue;
    out.push({
      type: typeof row.type === 'string' ? row.type : null,
      text: row.text.trim(),
    });
  }
  return out;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const lines = trimmed.split('\n');
  const openIdx = lines.findIndex(l => l.trim().startsWith('```'));
  if (openIdx === -1) return trimmed;

  let end = lines.length;
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) { end = i; break; }
  }
  return lines.slice(openIdx + 1, end).join('\n').trim();
}

export function parseExtractionResponse(raw: string): ExtractedMemory[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch (error) {
    throw new LLMError('extraction response was not valid JSON', { cause: error });
  }

  if (typeof parsed !== 'object' || parsed === null || !('memory' in parsed)) {
    throw new LLMError('extraction response missing "memory" key');
  }

  const list = (parsed as { memory: unknown }).memory;
  if (!Array.isArray(list)) {
    throw new LLMError('extraction response "memory" was not an array');
  }

  const out: ExtractedMemory[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.text !== 'string' || row.text.trim() === '') continue;
    if (row.attributed_to !== 'user' && row.attributed_to !== 'assistant') continue;

    out.push({
      id: String(row.id ?? out.length),
      text: row.text.trim(),
      attributed_to: row.attributed_to,
      linked_memory_ids: Array.isArray(row.linked_memory_ids)
        ? row.linked_memory_ids.filter((v): v is string => typeof v === 'string')
        : [],
      entities: parseEntities(row.entities),
    });
  }
  return out;
}

export async function extractMemories(
  provider: LLMProvider,
  args: PromptArgs,
): Promise<ExtractedMemory[]> {
  const prompt = generateAdditiveExtractionPrompt(args);
  let response: { text: string };
  try {
    response = await provider.complete(prompt, {
      systemPrompt: ADDITIVE_EXTRACTION_PROMPT + ENTITY_EXTRACTION_SUFFIX,
      maxTokens: 4000,
    });
  } catch (error) {
    throw new LLMError('extraction provider call failed', { cause: error });
  }
  return parseExtractionResponse(response.text);
}
