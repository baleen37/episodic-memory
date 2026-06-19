import { describe, expect, test } from 'bun:test';
import { distanceToScore } from './score.js';

describe('distanceToScore', () => {
  test('perfect match (distance 0) scores 1', () => {
    expect(distanceToScore(0)).toBeCloseTo(1, 5);
  });

  test('unrelated match (cos ~0.62) scores near 0', () => {
    const score = distanceToScore(Math.sqrt(2 * (1 - 0.62)));
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.1);
  });

  test('cos at or below the floor (0.6) clamps to 0', () => {
    expect(distanceToScore(Math.sqrt(2 * (1 - 0.6)))).toBeCloseTo(0, 10);
    expect(distanceToScore(Math.sqrt(2 * (1 - 0.5)))).toBe(0);
  });

  test('separates a strong match from an unrelated one by a wide margin', () => {
    const strong = distanceToScore(Math.sqrt(2 * (1 - 0.85)));
    const unrelated = distanceToScore(Math.sqrt(2 * (1 - 0.63)));
    expect(strong - unrelated).toBeGreaterThan(0.5);
  });

  test('is monotonic: larger distance never scores higher', () => {
    expect(distanceToScore(0.2)).toBeGreaterThanOrEqual(distanceToScore(0.5));
    expect(distanceToScore(0.5)).toBeGreaterThanOrEqual(distanceToScore(0.9));
  });
});
