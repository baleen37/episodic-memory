import { describe, expect, test } from 'bun:test';
import {
  calculateEmptyRate,
  calculateMrrAtK,
  calculateNdcgAtK,
  calculateRecallAtK,
} from './quality-metrics.js';

describe('search quality metrics', () => {
  test('nDCG rewards the ideal graded ordering', () => {
    const relevance = { direct: 3, partial: 2, context: 1 };
    expect(calculateNdcgAtK(['direct', 'partial', 'context'], relevance, 3)).toBeCloseTo(1, 10);
  });

  test('nDCG discounts a relevant result that appears later', () => {
    const relevance = { direct: 3, partial: 2 };
    const ideal = calculateNdcgAtK(['direct', 'partial'], relevance, 2);
    const late = calculateNdcgAtK(['noise', 'partial', 'direct'], relevance, 3);
    expect(ideal).toBeGreaterThan(late);
  });

  test('recall counts only relevance two or higher', () => {
    const relevance = { direct: 3, partial: 2, context: 1 };
    expect(calculateRecallAtK(['context', 'partial'], relevance, 2)).toBeCloseTo(1 / 2, 10);
  });

  test('MRR returns the reciprocal rank of the first relevant result', () => {
    const relevance = { direct: 3, partial: 2 };
    expect(calculateMrrAtK(['noise', 'partial', 'direct'], relevance, 3)).toBeCloseTo(0.5, 10);
    expect(calculateMrrAtK(['noise'], relevance, 1)).toBe(0);
  });

  test('empty rate counts queries with known relevant answers and no results', () => {
    expect(calculateEmptyRate([
      { resultIds: [], relevance: { direct: 3 } },
      { resultIds: ['direct'], relevance: { direct: 3 } },
      { resultIds: [], relevance: { context: 1 } },
    ])).toBeCloseTo(1 / 2, 10);
  });
});
