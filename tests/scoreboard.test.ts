import { expect, test } from 'vitest';
import { scoreboard } from '../src/ui/scoreboard';
import { teamColor } from '../src/rooms/colors';
import type { Cell } from '../src/game/types';

const members = [
  { id: 'a1', team: 'Amber', color: '#e0a', joined: true }, { id: 'a2', team: 'Amber', color: '#e0a', joined: false },
  { id: 'b1', team: 'Blue', color: '#0af', joined: true }, { id: 'c1', team: 'Cedar', color: '#0a5', joined: true },
];
const cells = (owners: Record<number, string>): Cell[] => Array.from({ length: 10000 }, (_, i) => ({ owner: owners[i] ?? null, shieldUntil: 0 }));
const spread = (team: string, n: number, from = 0) => Object.fromEntries(Array.from({ length: n }, (_, i) => [from + i, team]));

test('ranks every team by pixels, with bars relative to the leader, quiet teams last, and marks your own', () => {
  const board = scoreboard({ members, cells: cells({ ...spread('Blue', 8), ...spread('Amber', 4, 100) }), days: [], team: 'Amber', lastDay: false });
  expect(board.rows.map(r => [r.team, r.pixels, r.rank])).toEqual([['Blue', 8, 1], ['Amber', 4, 2], ['Cedar', 0, 3]]);
  expect(board.rows.map(r => r.share)).toEqual([1, 0.5, 0]);
  expect(board.rows.map(r => r.mine)).toEqual([false, true, false]);
  expect(board.rows[1]).toMatchObject({ joined: 1, total: 2 });
  expect(board.leader).toEqual({ team: 'Blue', pixels: 8, tied: false });
});

test('a tie for the lead is said to be a tie; an empty board has no leader', () => {
  expect(scoreboard({ members, cells: cells({ ...spread('Blue', 3), ...spread('Amber', 3, 100) }), days: [], team: 'Blue', lastDay: false }).leader).toMatchObject({ pixels: 3, tied: true });
  expect(scoreboard({ members, cells: cells({}), days: [], team: 'Blue', lastDay: false }).leader).toBeNull();
});

test('shows the latest closed day, the days won per team, and the overall leader', () => {
  const days = [{ day: 0, team: 'Blue', pixels: 9 }, { day: 1, team: 'Amber', pixels: 7 }, { day: 2, team: 'Amber', pixels: 12 }];
  const board = scoreboard({ members, cells: cells(spread('Blue', 2)), days, team: 'Cedar', lastDay: false });
  expect(board.lastDay).toEqual({ day: 2, team: 'Amber', pixels: 12 });
  expect(board.rows.find(r => r.team === 'Amber')!.wins).toBe(2);
  expect(board.champion).toEqual({ team: 'Amber', wins: 2, final: false });
});

test('on the last day the champion is marked as the final result if the day ended now', () => {
  const days = [{ day: 0, team: 'Blue', pixels: 9 }];
  const board = scoreboard({ members, cells: cells(spread('Amber', 2)), days, team: 'Cedar', lastDay: true });
  expect(board.champion).toEqual({ team: 'Amber', wins: 1, final: true });      // level on days: the team holding more pixels now
  expect(board.rows.find(r => r.team === 'Amber')!.wins).toBe(1);        // the live leader takes the last day, counted in its tally
});

test('without day results (local rooms) there is a ranking but no winners', () => {
  const board = scoreboard({ members, cells: cells(spread('Blue', 2)), days: undefined, team: 'Blue', lastDay: false });
  expect(board.lastDay).toBeNull(); expect(board.champion).toBeNull();
});

test('a team is drawn in the same color as on the canvas, whatever color the room stored for it', () => {
  const board = scoreboard({ members, cells: cells(spread('Blue', 2)), days: [], team: 'Blue', lastDay: false });
  for (const row of board.rows) expect(row.color).toBe(teamColor(row.team));
});
