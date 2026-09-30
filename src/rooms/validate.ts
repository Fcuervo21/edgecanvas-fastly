import type { Command } from '../game/types';
import { SIZE } from '../game/rules';
import type { RoomCommand } from './types';
import { RoomError } from './errors';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(k => allowed.includes(k));

/** Validates an untrusted command request; shared by the Node authority and the Fastly Compute authority. */
export function validateRoomCommand(input: unknown): RoomCommand {
  const invalid = (): never => { throw new RoomError(400, 'Invalid command.'); };
  if (!object(input) || !keys(input, ['id', 'command']) || typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id) || !object(input.command)) return invalid();
  const c = input.command;
  let command: Command;
  switch (c.type) {
    case 'buy':
      if (!keys(c, ['type', 'item']) || (c.item !== 'bomb' && c.item !== 'shield')) return invalid();
      command = { type: 'buy', item: c.item }; break;
    case 'advance':
      if (!keys(c, ['type', 'toMinute']) || !Number.isSafeInteger(c.toMinute) || (c.toMinute as number) < 0) return invalid();
      command = { type: 'advance', toMinute: c.toMinute as number }; break;
    case 'apply':
      if (!keys(c, ['type', 'tool', 'x', 'y', 'shape']) || !['brush', 'bomb', 'shield'].includes(c.tool as string)
        || !Number.isSafeInteger(c.x) || !Number.isSafeInteger(c.y)
        || c.shape !== undefined && !['pixel', 'circle', 'star', 'heart'].includes(c.shape as string)) return invalid();
      command = { type: 'apply', tool: c.tool as 'brush' | 'bomb' | 'shield', x: c.x as number, y: c.y as number,
        ...(c.shape === undefined ? {} : { shape: c.shape as 'pixel' | 'circle' | 'star' | 'heart' }) }; break;
    case 'stroke':
      if (!keys(c, ['type', 'points']) || !Array.isArray(c.points) || c.points.length > SIZE * SIZE
        || c.points.some(p => !object(p) || !keys(p, ['x', 'y']) || !Number.isSafeInteger(p.x) || !Number.isSafeInteger(p.y))) return invalid();
      command = { type: 'stroke', points: c.points.map(p => ({ x: p.x as number, y: p.y as number })) }; break;
    default: return invalid();
  }
  return { id: input.id, command };
}
