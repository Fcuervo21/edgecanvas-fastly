import { COST, SHIELD_MINUTES, SIZE } from './rules';
import { paintable, paintCost, previewTargets, validPoint } from './targets';
import type { Command, Dataset, GameState, Player, Result } from './types';

const fmt = (n: number) => n.toLocaleString('en-US');
const log = (s: GameState, message: string) => { s.messages = [message, ...s.messages].slice(0, 20); };

/** True once a shared room's clock is on the last day that has step data (solo play keeps replaying history). */
export const onLastDay = (state: Pick<GameState, 'minute' | 'competitive'>, dataset: Dataset) =>
  !!state.competitive && Math.floor(state.minute / 1440) >= dataset.dates.length - 1;

export function creditedThrough(dataset: Dataset, player: Player, day: number): number {
  const count = day + 1;
  const cycles = Math.floor(count / dataset.dates.length);
  const remaining = count % dataset.dates.length;
  return cycles * player.totalSteps + dataset.dates.slice(0, remaining).reduce((sum, date) => sum + (player.days[date] ?? 0), 0);
}
function creditMessage(dataset: Dataset, player: Player, day: number): string {
  const date = dataset.dates[day % dataset.dates.length];
  const steps = player.days[date];
  const repeat = day >= dataset.dates.length ? ' · history replay' : '';
  return steps == null ? `Day ${day + 1}: no record${repeat}.` : `Day ${day + 1}: +${fmt(steps)} paint${repeat}.`;
}
export function createGame(dataset: Dataset, playerId: string): GameState {
  const player = dataset.players.find(p => p.id === playerId);
  if (!player || !dataset.dates.length) throw new Error('Player or step history not found.');
  const balance = player.days[dataset.dates[0]] ?? 0;
  return {
    version: 1, playerId, team: player.team,
    cells: Array.from({ length: SIZE * SIZE }, () => ({ owner: null, shieldUntil: 0 })),
    balance, earned: balance, spent: 0, inventory: { bomb: 0, shield: 0 }, minute: 0, lastCreditedDay: 0,
    messages: [creditMessage(dataset, player, 0)],
  };
}
export function dispatch(state: GameState, command: Command, dataset: Dataset): Result {
  const reject = (code: Result['code']): Result => ({ state, code, changed: [] });
  if (command.type === 'stroke') {
    if (command.points.length > SIZE * SIZE || command.points.some(p => !validPoint(p.x, p.y))) return reject('OUT_OF_BOUNDS');
    const targets = [...new Set(command.points.map(p => p.y * SIZE + p.x))].filter(i => paintable(state, i));
    if (!targets.length) return reject('NO_CHANGE');
    const changed: number[] = [];
    let price = 0;
    for (const index of targets) {
      const cost = paintCost(state, [index]);
      if (price + cost > state.balance) break;
      changed.push(index); price += cost;
    }
    if (!changed.length) return reject('INSUFFICIENT_PAINT');
    const next = { ...state, cells: state.cells.slice(), balance: state.balance - price, spent: state.spent + price };
    for (const i of changed) next.cells[i] = { owner: state.team, shieldUntil: 0 };
    log(next, `Brush · ${changed.length} ${changed.length === 1 ? 'pixel painted' : 'pixels painted'}.`);
    return { state: next, code: 'OK', changed };
  }
  if (command.type === 'advance') {
    if (!Number.isSafeInteger(command.toMinute) || command.toMinute < state.minute) return reject('INVALID_TIME');
    if (command.toMinute === state.minute) return reject('NO_CHANGE');
    const day = Math.floor(command.toMinute / 1440);
    // Shared rooms end with the data: never invent steps for days that were not recorded.
    if (state.competitive && day >= dataset.dates.length) return reject('NO_MORE_DAYS');
    const player = dataset.players.find(p => p.id === state.playerId)!;
    const earned = creditedThrough(dataset, player, day);
    if (!Number.isSafeInteger(earned)) return reject('INVALID_TIME');
    const next = { ...state, minute: command.toMinute, lastCreditedDay: day, earned,
      balance: earned - state.spent, cells: state.cells.map(cell => cell.shieldUntil > 0 && cell.shieldUntil <= command.toMinute ? { ...cell, shieldUntil: 0 } : cell) };
    if (day > state.lastCreditedDay) log(next, creditMessage(dataset, player, day));
    return { state: next, code: 'OK', changed: [] };
  }
  if (command.type === 'buy') {
    const price = COST[command.item];
    if (state.balance < price) return reject('INSUFFICIENT_PAINT');
    const next = { ...state, balance: state.balance - price, spent: state.spent + price,
      inventory: { ...state.inventory, [command.item]: state.inventory[command.item] + 1 } };
    log(next, `${command.item === 'bomb' ? 'Bomb' : 'Shield'} purchased · −${fmt(price)} paint.`);
    return { state: next, code: 'OK', changed: [] };
  }
  if (!validPoint(command.x, command.y)) return reject('OUT_OF_BOUNDS');
  if (command.tool !== 'brush' && state.inventory[command.tool] < 1) return reject('NO_ITEM');
  const changed = previewTargets(state, command.tool, command.x, command.y, command.shape);
  if (!changed.length) return reject('NO_CHANGE');
  const price = command.tool === 'brush' ? paintCost(state, changed) : 0;
  if (state.balance < price) return reject('INSUFFICIENT_PAINT');
  const next = { ...state, balance: state.balance - price, spent: state.spent + price,
    cells: state.cells.slice(), inventory: { ...state.inventory } };
  for (const index of changed) {
    next.cells[index] = command.tool === 'shield'
      ? { ...state.cells[index], shieldUntil: state.minute + SHIELD_MINUTES }
      : { owner: state.team, shieldUntil: 0 };
  }
  if (command.tool !== 'brush') next.inventory[command.tool]--;
  log(next, command.tool === 'shield' ? `Shield active on ${changed.length} pixels · 2 simulated hours.`
    : `${command.tool === 'bomb' ? 'Bomb' : 'Brush'} · ${changed.length} ${changed.length === 1 ? 'pixel painted' : 'pixels painted'}.`);
  return { state: next, code: 'OK', changed };
}
