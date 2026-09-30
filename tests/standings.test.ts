import { expect, test } from 'vitest';
import { champion, dayResult, pixelCounts, ranking } from '../src/game/standings';
import type { Cell } from '../src/game/types';

const board = (owners: Record<number, string>): Cell[] => Array.from({ length: 10000 }, (_, i) => ({ owner: owners[i] ?? null, shieldUntil: 0 }));
const paint = (team: string, from: number, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [from + i, team]));

test('counts pixels per team and ranks them, listing quiet teams too', () => {
  const cells = board({ ...paint('A', 0, 5), ...paint('B', 100, 8) });
  expect([...pixelCounts(cells)]).toEqual([['A', 5], ['B', 8]]);
  expect(ranking(pixelCounts(cells), ['A', 'B', 'C'])).toEqual([{ team: 'B', pixels: 8 }, { team: 'A', pixels: 5 }, { team: 'C', pixels: 0 }]);
  expect(ranking(new Map([['Y', 3], ['X', 3]]), [])).toEqual([{ team: 'X', pixels: 3 }, { team: 'Y', pixels: 3 }]);   // ties read alphabetically
});

test('a day is won by the team with strictly the most pixels when the day closes', () => {
  expect(dayResult(2, board({ ...paint('A', 0, 5), ...paint('B', 100, 8) }))).toEqual({ day: 2, team: 'B', pixels: 8 });
  expect(dayResult(0, board({ ...paint('A', 0, 4), ...paint('B', 100, 4) }))).toEqual({ day: 0, team: null, pixels: 4 });   // tie: nobody
  expect(dayResult(1, board({}))).toEqual({ day: 1, team: null, pixels: 0 });
});

test('the overall leader has won the most days; ties go to whoever holds more pixels now', () => {
  const days = [{ day: 0, team: 'A', pixels: 9 }, { day: 1, team: 'B', pixels: 9 }, { day: 2, team: 'A', pixels: 4 }, { day: 3, team: null, pixels: 4 }];
  expect(champion(days, new Map([['A', 1], ['B', 50]]), false)).toEqual({ team: 'A', wins: 2 });
  expect(champion(days.slice(0, 2), new Map([['A', 1], ['B', 50]]), false)).toEqual({ team: 'B', wins: 1 });
  expect(champion([], new Map([['A', 1]]), false)).toBeNull();
});

test('on the last day the team leading right now takes that day, so the final result is known when it ends', () => {
  const days = [{ day: 0, team: 'A', pixels: 9 }, { day: 1, team: 'B', pixels: 9 }];
  expect(champion(days, new Map([['A', 1], ['B', 50]]), true)).toEqual({ team: 'B', wins: 2 });
  expect(champion(days, new Map([['A', 60], ['B', 50]]), true)).toEqual({ team: 'A', wins: 2 });
  expect(champion(days, new Map(), true)).toEqual({ team: 'A', wins: 1 });   // an empty board wins nothing; A and B tie on 1, alphabetical
});
