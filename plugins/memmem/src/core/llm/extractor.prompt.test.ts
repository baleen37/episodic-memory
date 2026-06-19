import { describe, expect, test } from 'bun:test';
import { MEMORY_EXTRACT_SYSTEM_PROMPT } from './extractor.js';

describe('MEMORY_EXTRACT_SYSTEM_PROMPT', () => {
  test('instructs the model to write memory text in English', () => {
    expect(MEMORY_EXTRACT_SYSTEM_PROMPT).toMatch(/write each record's text in English/i);
  });

  test('instructs translation of non-English content', () => {
    expect(MEMORY_EXTRACT_SYSTEM_PROMPT).toMatch(/translate non-English content/i);
  });

  test('preserves identifiers/paths/proper nouns verbatim', () => {
    expect(MEMORY_EXTRACT_SYSTEM_PROMPT).toMatch(/preserve code identifiers, file paths, and proper nouns verbatim/i);
  });
});
