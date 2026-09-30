import { expect, test } from 'vitest';
import { createGame, dispatch } from '../src/game/engine';
import { loadSession, saveSession, STORAGE_KEY } from '../src/storage/session';
import type { Dataset } from '../src/game/types';
const data: Dataset = { dates: ['2026-07-01'], players: [{ id: 'Amber Foxes:Alex Rivera', name: 'Alex Rivera', team: 'Amber Foxes', totalSteps: 6373, dailyGoal: 3000, days: { '2026-07-01': 6373 } }] };
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return { get length() { return map.size; }, clear: () => map.clear(), getItem: k => map.get(k) ?? null,
    key: i => [...map.keys()][i] ?? null, removeItem: k => { map.delete(k); }, setItem: (k,v) => { map.set(k,v); } };
}
test('restores painted cells and spent balance without recrediting', () => {
  const storage = memoryStorage();
  expect(loadSession(storage, data)).toEqual({ kind: 'empty' });
  const state = dispatch(createGame(data, data.players[0].id), { type: 'apply', tool: 'brush', x: 1, y: 2 }, data).state;
  expect(saveSession(storage, state)).toBe(true);
  expect(loadSession(storage, data)).toEqual({ kind: 'valid', state });
});
test.each([
  (s: any) => { s.balance = -1; },
  (s: any) => { s.balance++; },
  (s: any) => { s.cells.pop(); },
  (s: any) => { s.earned++; s.balance++; },
  (s: any) => { s.lastCreditedDay = 1; },
  (s: any) => { s.cells[0].shieldUntil = 100; },
  (s: any) => { s.inventory.bomb = -1; },
])('refuses inconsistent saved state without overwriting it', change => {
  const storage = memoryStorage();
  const state = createGame(data, data.players[0].id);
  change(state);
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
  const before = storage.getItem(STORAGE_KEY);
  expect(loadSession(storage, data)).toEqual({ kind: 'invalid' });
  expect(storage.getItem(STORAGE_KEY)).toBe(before);
});
test('reports unavailable storage rather than claiming progress was saved', () => {
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error('quota'); };
  storage.getItem = () => { throw new Error('disabled'); };
  expect(saveSession(storage, createGame(data, data.players[0].id))).toBe(false);
  expect(loadSession(storage, data)).toEqual({ kind: 'unavailable' });
});
test('refuses malformed JSON', () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, '{');
  expect(loadSession(storage, data)).toEqual({ kind: 'invalid' });
});
test('translates existing Spanish activity without changing saved gameplay', () => {
  const storage = memoryStorage();
  const state = createGame(data, data.players[0].id);
  state.messages = [
    'Día 2: +9,192 de pintura · repetición del historial.',
    'Día 3: sin registro.',
    'Bomba comprado · −1,500 de pintura.',
    'Escudo comprado · −1,000 de pintura.',
    'Brochazo · 1 casilla pintada.',
    'Bomba · 25 casillas pintadas.',
    'Escudo activo en 9 casillas · 2 h simuladas.',
  ];
  saveSession(storage, state);
  const loaded = loadSession(storage, data);
  expect(loaded.kind).toBe('valid');
  if (loaded.kind !== 'valid') throw new Error('Expected saved session');
  expect(loaded.state).toEqual({ ...state, messages: [
    'Day 2: +9,192 paint · history replay.', 'Day 3: no record.',
    'Bomb purchased · −1,500 paint.', 'Shield purchased · −1,000 paint.',
    'Brush · 1 pixel painted.', 'Bomb · 25 pixels painted.',
    'Shield active on 9 pixels · 2 simulated hours.',
  ] });
});
