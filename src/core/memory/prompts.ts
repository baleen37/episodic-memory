/** Verbatim port of ADDITIVE_EXTRACTION_PROMPT from mem0/configs/prompts.py:469-943 (v2.0.17).
 *  Generated from upstream source — do not hand-edit or paraphrase. */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const promptPath = join(__dirname, '../../../.superpowers/sdd/2026-08-11-mem0-v2-architecture/additive-extraction-prompt.txt');

export const ADDITIVE_EXTRACTION_PROMPT = readFileSync(promptPath, 'utf-8');

export const PAST_MESSAGE_TRUNCATION_LIMIT = 300;

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface ExistingMemoryRef {
  id: string;
  text: string;
}

export interface PromptArgs {
  summary?: string | null;
  recentlyExtractedMemories?: ExistingMemoryRef[];
  existingMemories?: ExistingMemoryRef[];
  newMessages: Message[];
  lastKMessages?: Message[];
  currentDate?: string;
  observationDate?: string;
  customInstructions?: string;
}

function truncate(text: string, limit = PAST_MESSAGE_TRUNCATION_LIMIT): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

function formatSummary(summary?: string | null): string {
  return summary && summary.trim() ? summary : '';
}

function formatConversationHistory(messages?: Message[]): string {
  if (!messages || messages.length === 0) return '';
  return messages.map(m => `${m.role}: ${truncate(m.content)}`).join('\n');
}

function serializeMemories(memories?: ExistingMemoryRef[]): string {
  if (!memories || memories.length === 0) return '[]';
  return JSON.stringify(memories.map(m => ({ id: m.id, text: m.text })), null, 0)
    .replace(/},"/g, '}, "')
    .replace(/\{"id":/g, '{"id": ')
    .replace(/,"text":/g, ', "text": ');
}

function formatNewMessages(messages: Message[]): string {
  return JSON.stringify(messages.map(m => ({ role: m.role, content: m.content })));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Generates the full extraction prompt by combining the base prompt with context sections. */
export function generateAdditiveExtractionPrompt(args: PromptArgs): string {
  const now = new Date();
  const currentDate = args.currentDate ?? isoDate(now);
  const observationDate = args.observationDate ?? currentDate;

  const sections = [
    `## Summary\n${formatSummary(args.summary)}`,
    `## Last k Messages\n${formatConversationHistory(args.lastKMessages)}`,
    `## Recently Extracted Memories\n${serializeMemories(args.recentlyExtractedMemories)}`,
    `## Existing Memories\n${serializeMemories(args.existingMemories)}`,
    `## New Messages\n${formatNewMessages(args.newMessages)}`,
    `## Observation Date\n${observationDate}`,
    `## Current Date\n${currentDate}`,
  ];

  if (args.customInstructions) {
    sections.push(`## Custom Instructions\n${args.customInstructions}`);
  }

  sections.push('# Output:');
  return sections.join('\n\n');
}
