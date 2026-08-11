import { describe, test, expect } from 'bun:test';
import { Semaphore, withSemaphore } from './semaphore.js';

describe('Semaphore', () => {
  test('never exceeds maxConcurrent', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;

    const task = () => withSemaphore(sem, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
      return true;
    });

    await Promise.all(Array.from({ length: 10 }, task));
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  test('releases the slot when the callback throws', async () => {
    const sem = new Semaphore(1);
    await expect(withSemaphore(sem, async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');

    // If the slot leaked, this would hang forever rather than resolve.
    const result = await withSemaphore(sem, async () => 'ok');
    expect(result).toBe('ok');
  });

  test('runs everything when maxConcurrent exceeds the work count', async () => {
    const sem = new Semaphore(8);
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, i) => withSemaphore(sem, async () => i)),
    );
    expect(results).toEqual([0, 1, 2]);
  });

  test('treats a non-positive limit as 1', async () => {
    const sem = new Semaphore(0);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 4 }, () => withSemaphore(sem, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    })));
    expect(peak).toBe(1);
  });
});
