import { expect, test } from 'vitest';
import { scheduleReveal } from '../src/ui/reveal';

test('one changed pixel shows immediately', () => {
  expect(scheduleReveal([42], 1000)).toEqual(new Map([[42, 1000]]));
});

test('a line of pixels is revealed one after another in the order received', () => {
  const times = scheduleReveal([5, 6, 7, 8, 9], 1000);
  const order = [...times.entries()];
  expect(order.map(([index]) => index)).toEqual([5, 6, 7, 8, 9]);
  const at = order.map(([, time]) => time);
  expect(at[0]).toBe(1000);
  expect(at.every((time, i) => i === 0 || time > at[i - 1])).toBe(true);
});

test('a big burst is spread over a short, bounded time and never later than that', () => {
  const changed = Array.from({ length: 900 }, (_, i) => i);
  const times = scheduleReveal(changed, 5000);
  expect(times.size).toBe(900);
  expect(Math.max(...times.values()) - 5000).toBeLessThanOrEqual(400);
  expect(Math.min(...times.values())).toBe(5000);
});

test('duplicates are revealed once and an empty change schedules nothing', () => {
  expect(scheduleReveal([3, 3, 4, 3], 0).size).toBe(2);
  expect(scheduleReveal([], 0).size).toBe(0);
});
