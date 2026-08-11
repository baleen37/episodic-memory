import { describe, test, expect } from 'bun:test';
import { sliceBatchOutput } from './embeddings-model.js';
import { EMBEDDING_DIM } from './constants.js';

describe('sliceBatchOutput', () => {
  test('splits a flat tensor into one vector per input', () => {
    const rows = 3;
    const data = new Float32Array(rows * EMBEDDING_DIM);
    for (let i = 0; i < data.length; i++) data[i] = i;

    const result = sliceBatchOutput(data, rows);

    expect(result).toHaveLength(rows);
    expect(result[0]).toHaveLength(EMBEDDING_DIM);
    expect(result[0][0]).toBe(0);
    expect(result[1][0]).toBe(EMBEDDING_DIM);
    expect(result[2][EMBEDDING_DIM - 1]).toBe(rows * EMBEDDING_DIM - 1);
  });

  test('throws when the tensor length is not a multiple of the row count', () => {
    const data = new Float32Array(EMBEDDING_DIM + 5);
    expect(() => sliceBatchOutput(data, 2)).toThrow(/expected 2/);
  });

  test('returns an empty array for zero rows', () => {
    expect(sliceBatchOutput(new Float32Array(0), 0)).toEqual([]);
  });
});
