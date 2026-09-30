import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseSteps } from '../src/data/steps';
import { createGame, dispatch } from '../src/game/engine';

const csv = readFileSync(new URL('../StepsData/sample_step_data.csv', import.meta.url), 'utf8');
const header = 'Team Source,Name,Total Steps,Daily Step Goal,2026-07-01,2026-07-02';
test('the sample 62-day cycle credits 211043 steps, then labels a repeated history', () => {
  const d = parseSteps(csv);
  const initial = createGame(d, 'Amber Foxes:Alex Rivera');
  const last = dispatch(initial, { type: 'advance', toMinute: 61 * 1440 }, d).state;
  expect(last.balance).toBe(211043);
  const repeat = dispatch(last, { type: 'advance', toMinute: 62 * 1440 }, d).state;
  expect(repeat.balance).toBe(217416);
  expect(repeat.messages[0]).toMatch(/history replay/i);
  expect(dispatch(repeat, { type: 'advance', toMinute: 62 * 1440 }, d).state.balance).toBe(217416);
});
test('reads all participants and reconciles the sample history', () => {
  const d = parseSteps(csv);
  expect(d.players).toHaveLength(23);
  expect(new Set(d.players.map(p => p.team)).size).toBe(10);
  expect(d.dates).toHaveLength(62);
  const p = d.players.find(p => p.name === 'Alex Rivera')!;
  expect(p.team).toBe('Amber Foxes');
  expect(p.days['2026-07-01']).toBe(6373);
  expect(p.days['2026-07-02']).toBe(9192);
  expect(Object.values(p.days).reduce<number>((s, v) => s + (v ?? 0), 0)).toBe(211043);
});
test('preserves missing records separately from zero and grouped numbers', () => {
  const d = parseSteps(`${header}\nAmber Foxes,A,0,3000,N.A,0\nAmber Foxes,B,"9,192",3000,,"9,192"`);
  expect(d.players[0].days).toEqual({ '2026-07-01': null, '2026-07-02': 0 });
  expect(d.players[1].days['2026-07-02']).toBe(9192);
});
test.each(['-1', '1.2', 'abc', '"9,19"', '9007199254740992'])('rejects invalid step value %s', value => {
  expect(() => parseSteps(`${header}\nAmber Foxes,A,0,3000,${value},0`)).toThrow();
});
test('rejects duplicate people and mismatched totals', () => {
  expect(() => parseSteps(`${header}\nAmber Foxes,A,0,3000,0,0\nAmber Foxes, A ,0,3000,0,0`)).toThrow(/duplicate/i);
  expect(() => parseSteps(`${header}\nAmber Foxes,A,5,3000,1,1`)).toThrow(/total/i);
});
test('rejects duplicate headers, invalid dates and gaps', () => {
  expect(() => parseSteps(`${header},Name\nAmber Foxes,A,0,3000,0,0,A`)).toThrow(/column/i);
  expect(() => parseSteps(`${header.replace('2026-07-02', '2026-07-03')}\nAmber Foxes,A,0,3000,0,0`)).toThrow(/date/i);
  expect(() => parseSteps(`${header.replace('2026-07-02', '2026-02-30')}\nAmber Foxes,A,0,3000,0,0`)).toThrow(/date/i);
});
