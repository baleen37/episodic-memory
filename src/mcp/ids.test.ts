import { describe, expect, test } from 'bun:test';
import { compactMemoryId, expandMemoryId } from './ids.js';

describe('compact memory ids', () => {
  test('encodes UUIDs into a reversible 24-character public id', () => {
    const canonicalId = '123e4567-e89b-12d3-a456-426614174000';
    const publicId = compactMemoryId(canonicalId);

    expect(publicId).toMatch(/^e_[A-Za-z0-9_-]{22}$/);
    expect(publicId).toHaveLength(24);
    expect(expandMemoryId(publicId)).toBe(canonicalId);
  });

  test('encodes non-UUID ids with a reversible fallback', () => {
    const canonicalId = 'legacy/memory identifier';
    const publicId = compactMemoryId(canonicalId);

    expect(publicId).toMatch(/^e~/);
    expect(expandMemoryId(publicId)).toBe(canonicalId);
  });

  test('accepts a canonical id for direct read compatibility', () => {
    const canonicalId = 'memory-1';
    expect(expandMemoryId(canonicalId)).toBe(canonicalId);
  });
});
