import { creditedThrough } from '../game/engine';
import { SIZE } from '../game/rules';
import type { Dataset, GameState } from '../game/types';

export const STORAGE_KEY = 'edgecanvas.single-player.v1';
const uint = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function saveSession(storage: Storage, state: GameState): boolean {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; } catch { return false; }
}
export function loadSession(storage: Storage, dataset: Dataset):
  { kind: 'empty' } | { kind: 'valid'; state: GameState } | { kind: 'invalid' } | { kind: 'unavailable' } {
  let raw: string | null;
  try { raw = storage.getItem(STORAGE_KEY); } catch { return { kind: 'unavailable' }; }
  if (raw === null) return { kind: 'empty' };
  try {
    const s = JSON.parse(raw);
    const player = dataset.players.find(p => p.id === s?.playerId);
    if (!player || s.version !== 1 || s.team !== player.team
      || ![s.balance, s.earned, s.spent, s.minute, s.lastCreditedDay, s.inventory?.bomb, s.inventory?.shield].every(uint)
      || s.balance !== s.earned - s.spent || s.lastCreditedDay !== Math.floor(s.minute / 1440)
      || creditedThrough(dataset, player, s.lastCreditedDay) !== s.earned
      || !Array.isArray(s.cells) || s.cells.length !== SIZE * SIZE
      || !s.cells.every((c: unknown) => {
        if (!c || typeof c !== 'object' || !('owner' in c) || !('shieldUntil' in c) || !uint(c.shieldUntil)) return false;
        return (c.owner === null || c.owner === s.team) && (c.shieldUntil === 0 || (c.owner === s.team && c.shieldUntil > s.minute));
      })
      || !Array.isArray(s.messages) || s.messages.length > 20 || !s.messages.every((m: unknown) => typeof m === 'string')) return { kind: 'invalid' };
    return { kind: 'valid', state: s as GameState };
  } catch { return { kind: 'invalid' }; }
}
