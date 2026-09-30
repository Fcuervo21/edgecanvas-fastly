import { expect, test } from 'vitest';
import { createGame, dispatch } from '../src/game/engine';
import { previewTargets } from '../src/game/targets';
import type { Dataset, GameState, Command } from '../src/game/types';
import { COST } from '../src/game/rules';

export const data: Dataset = { dates: ['2026-07-01', '2026-07-02'], players: [{
  id: 'Amber Foxes:Alex Rivera', name: 'Alex Rivera', team: 'Amber Foxes', totalSteps: 15565,
  dailyGoal: 3000, days: { '2026-07-01': 6373, '2026-07-02': 9192 }
}] };
const start = () => createGame(data, data.players[0].id);
const act = (s: GameState, c: Command) => dispatch(s, c, data);
test('charges only successful painting and never mutates the previous state', () => {
  const s = start();
  const paint = act(s, { type: 'apply', tool: 'brush', x: 5, y: 8 });
  expect(paint.state.balance).toBe(6373 - COST.brush);
  expect(paint.changed).toEqual([805]);
  expect(s.balance).toBe(6373);
  expect(s.cells[805].owner).toBeNull();
  expect(act(paint.state, { type: 'apply', tool: 'brush', x: 5, y: 8 }).state).toBe(paint.state);
});
test('credits the next midnight exactly once including when crossing in small increments', () => {
  const painted = act(start(), { type: 'apply', tool: 'brush', x: 5, y: 8 }).state;
  const before = act(painted, { type: 'advance', toMinute: 1430 }).state;
  expect(before.balance).toBe(6373 - COST.brush);
  const next = act(before, { type: 'advance', toMinute: 1440 }).state;
  expect(next.balance).toBe(6373 + 9192 - COST.brush);
  expect(act(next, { type: 'advance', toMinute: 1440 }).state.balance).toBe(6373 + 9192 - COST.brush);
});
test('repeats historical days as a new simulated cycle', () => {
  const next = act(start(), { type: 'advance', toMinute: 2880 }).state;
  expect(next.balance).toBe(21938);
  expect(next.lastCreditedDay).toBe(2);
  expect(next.messages.join(' ')).toMatch(/history replay/i);
});
test('missing daily data does not invent credits', () => {
  const missing: Dataset = { dates: ['2026-07-01'], players: [{ ...data.players[0], totalSteps: 0, days: { '2026-07-01': null } }] };
  const s = createGame(missing, missing.players[0].id);
  expect(s.balance).toBe(0);
  expect(s.messages.join(' ')).toMatch(/no record/i);
});
test.each([-1, 1.5, NaN, Infinity])('rejects invalid time %s without mutation', minute => {
  const s = start();
  expect(act(s, { type: 'advance', toMinute: minute })).toMatchObject({ state: s, code: 'INVALID_TIME' });
});
test.each([[-1, 0], [100, 0], [0, 100], [1.1, 2], [NaN, 0]])('rejects invalid coordinates %s %s', (x,y) => {
  const s = start();
  expect(act(s, { type: 'apply', tool: 'brush', x, y }).state).toBe(s);
});
test('does not partially paint when funds are insufficient', () => {
  const s = { ...start(), balance: COST.brush - 1, spent: 6373 - (COST.brush - 1) };
  expect(act(s, { type: 'apply', tool: 'brush', x: 0, y: 0 }).code).toBe('INSUFFICIENT_PAINT');
  expect(act(s, { type: 'buy', item: 'bomb' }).state).toBe(s);
});
test('buys a bomb once and uses inventory without a second charge', () => {
  const bought = act(start(), { type: 'buy', item: 'bomb' }).state;
  expect(bought.balance).toBe(6373 - COST.bomb);
  expect(bought.inventory.bomb).toBe(1);
  const blast = act(bought, { type: 'apply', tool: 'bomb', x: 50, y: 50 });
  expect(blast.changed).toHaveLength(25);
  expect(blast.changed).toEqual(previewTargets(bought, 'bomb', 50, 50));
  expect(blast.state.balance).toBe(6373 - COST.bomb);
  expect(blast.state.inventory.bomb).toBe(0);
});
test('clips a corner bomb to nine cells and keeps items when no cells can change', () => {
  const bought = act(start(), { type: 'buy', item: 'bomb' }).state;
  const blast = act(bought, { type: 'apply', tool: 'bomb', x: 0, y: 0 });
  expect(blast.changed).toHaveLength(9);
  const again = act(blast.state, { type: 'buy', item: 'bomb' }).state;
  expect(act(again, { type: 'apply', tool: 'bomb', x: 0, y: 0 }).state).toBe(again);
  expect(act(start(), { type: 'apply', tool: 'bomb', x: 50, y: 50 }).code).toBe('NO_ITEM');
});
test('shields only owned cells and expires at exactly 120 simulated minutes', () => {
  const bought = act(start(), { type: 'buy', item: 'shield' }).state;
  expect(act(bought, { type: 'apply', tool: 'shield', x: 5, y: 8 }).state).toBe(bought);
  const painted = act(bought, { type: 'apply', tool: 'brush', x: 5, y: 8 }).state;
  const shielded = act(painted, { type: 'apply', tool: 'shield', x: 5, y: 8 }).state;
  expect(shielded.cells[805].shieldUntil).toBe(120);
  expect(shielded.cells[804].shieldUntil).toBe(0);
  expect(act(shielded, { type: 'advance', toMinute: 119 }).state.cells[805].shieldUntil).toBe(120);
  expect(act(shielded, { type: 'advance', toMinute: 120 }).state.cells[805].shieldUntil).toBe(0);
  const second = act(shielded, { type: 'buy', item: 'shield' }).state;
  expect(act(second, { type: 'apply', tool: 'shield', x: 5, y: 8 }).state).toBe(second);
});

test('a competitive room stops at the last day with step data instead of replaying history', () => {
  const room: GameState = { ...start(), competitive: true };
  const lastDay = act(room, { type: 'advance', toMinute: 1440 });
  expect(lastDay.code).toBe('OK');
  // Still inside the last day: minutes may keep moving.
  expect(act(lastDay.state, { type: 'advance', toMinute: 2879 }).code).toBe('OK');
  // Past its end there is no more data: nothing changes and nobody is credited invented steps.
  const beyond = act(lastDay.state, { type: 'advance', toMinute: 2880 });
  expect(beyond.code).toBe('NO_MORE_DAYS');
  expect(beyond.state).toBe(lastDay.state);
});
