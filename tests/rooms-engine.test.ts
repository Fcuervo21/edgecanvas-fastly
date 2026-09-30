import { expect, test } from 'vitest';
import { createGame, dispatch } from '../src/game/engine';
import type { Dataset, GameState } from '../src/game/types';
import { COST } from '../src/game/rules';

const dataset: Dataset = { dates: ['2026-07-01'], players: [{ id: 'a', name: 'A', team: 'Amber Foxes', totalSteps: 5000, dailyGoal: 1, days: { '2026-07-01': 5000 } }] };
const start = () => ({ ...createGame(dataset, 'a'), competitive: true });
test('competitive conquest costs the rival price, empty the brush price, and teammates remain free', () => {
  const state = start();
  state.cells[0].owner = 'rival'; state.cells[1].owner = 'Amber Foxes';
  const result = dispatch(state, { type: 'stroke', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] }, dataset);
  expect(result.changed).toEqual([0, 2]);
  expect(result.state.balance).toBe(5000 - COST.rival - COST.brush);
  expect(result.state.cells[0].owner).toBe('Amber Foxes');
  expect(state.cells[0].owner).toBe('rival');
});
test('competitive brush and bomb skip protected rivals; shields only affect teammates', () => {
  const state = start();
  state.cells[0] = { owner: 'rival', shieldUntil: 120 };
  state.cells[1] = { owner: 'rival', shieldUntil: 0 };
  state.cells[2].owner = 'Amber Foxes';
  const brush = dispatch(state, { type: 'apply', tool: 'brush', x: 1, y: 0 }, dataset);
  expect(brush.state.balance).toBe(5000 - COST.rival);
  expect(dispatch(state, { type: 'apply', tool: 'brush', x: 0, y: 0 }, dataset).code).toBe('NO_CHANGE');
  state.inventory.bomb = 1; state.inventory.shield = 1;
  const bomb = dispatch(state, { type: 'apply', tool: 'bomb', x: 1, y: 0 }, dataset);
  expect(bomb.changed).toContain(1); expect(bomb.changed).not.toContain(0);
  expect(bomb.state.balance).toBe(5000);
  const shield = dispatch(state, { type: 'apply', tool: 'shield', x: 1, y: 0 }, dataset);
  expect(shield.changed).toEqual([2]); expect(shield.state.cells[2].shieldUntil).toBe(120);
});
test('competitive strokes charge sequential mixed costs only within the remaining budget', () => {
  const state: GameState = { ...start(), balance: COST.rival + COST.brush - 5 };
  state.cells[0].owner = 'rival';
  const result = dispatch(state, { type: 'stroke', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }, dataset);
  expect(result.changed).toEqual([0]); expect(result.state.balance).toBe(COST.brush - 5);
});
