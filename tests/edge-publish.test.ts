import { expect, test } from 'vitest';
import { createEdgeAuthority } from '../src/edge/authority';
import { MemoryKV, type EdgeKV } from '../src/edge/kv';
import type { EdgeEvent } from '../src/edge/types';
import { acceptanceDataset } from './fixtures/room-roster';
import { COST } from '../src/game/rules';

const dataset = acceptanceDataset();
const host = dataset.players[0].id;

async function room(options: Parameters<typeof createEdgeAuthority>[0]) {
  const authority = createEdgeAuthority(options);
  const created = await authority.createRoom({ name: 'Edge', hostId: host, dataset });
  const invite = created.invites.find(i => i.playerId === host)!;
  const token = (await authority.join(created.code, { inviteCode: invite.code })).session.token;
  return { authority, code: created.code, token };
}
const rowStroke = { type: 'stroke' as const, points: Array.from({ length: 100 }, (_, x) => ({ x, y: 0 })) };

test('a command that changes many tiles publishes them in a single batch', async () => {
  const batches: EdgeEvent[][] = [];
  const { authority, code, token } = await room({ kv: new MemoryKV(), publishBatch: async (_room, events) => { batches.push(events); } });
  batches.length = 0; // Joining announces the roster; only the paint matters here.
  const reply = await authority.command(code, token, { id: 'row', command: rowStroke });
  expect(reply.code).toBe('OK');
  const tileBatches = batches.filter(batch => batch.some(event => event.type === 'tile'));
  expect(tileBatches).toHaveLength(1);
  expect(tileBatches[0].filter(event => event.type === 'tile')).toHaveLength(10);
});

test('without a batch publisher every event still goes out one by one', async () => {
  const events: EdgeEvent[] = [];
  const { authority, code, token } = await room({ kv: new MemoryKV(), publish: async (_room, event) => { events.push(event); } });
  events.length = 0;
  await authority.command(code, token, { id: 'row', command: rowStroke });
  expect(events.filter(event => event.type === 'tile')).toHaveLength(10);
});

test('a hosted room does not create unused invite records', async () => {
  const kv = new MemoryKV();
  const authority = createEdgeAuthority({ kv });
  const created = await authority.createRoom({ name: 'Edge', hostId: host, dataset }, { invites: false });
  expect(created.invites).toEqual([]);
  // Room record and room index only; every extra write costs about 200 ms on the real KV Store.
  expect(kv.writes).toBeLessThanOrEqual(3);
});

test('a command that changes many tiles saves them in parallel, and money still adds up', async () => {
  const inner = new MemoryKV(Math.random, () => new Promise(resolve => setTimeout(resolve, 4)));
  let inFlight = 0, peak = 0;
  const kv: EdgeKV = {
    get: key => inner.get(key), put: (key, value) => inner.put(key, value), delete: key => inner.delete(key), list: prefix => inner.list(prefix),
    async add(key, value, options) {
      const tile = /\/t\/\d+\/\d+$/.test(key);
      if (tile) { inFlight++; peak = Math.max(peak, inFlight); }
      try { return await inner.add(key, value, options); } finally { if (tile) inFlight--; }
    },
  };
  const { authority, code, token } = await room({ kv });
  const reply = await authority.command(code, token, { id: 'row', command: rowStroke });
  expect(reply.code).toBe('OK');
  expect(peak).toBeGreaterThan(4);
  // 100 new pixels at the brush price, charged exactly once.
  expect(reply.wallet.state.spent).toBe(100 * COST.brush);
  expect(reply.tiles).toHaveLength(10);
});

test('a bomb or shield announces its effect (where, and for which team) before the tiles it changes', async () => {
  const events: EdgeEvent[] = [];
  const { authority, code, token } = await room({ kv: new MemoryKV(), publishBatch: async (_room, batch) => { events.push(...batch); } });
  await authority.command(code, token, { id: 'buy', command: { type: 'buy', item: 'bomb' } }).catch(() => {});
  events.length = 0;
  const day = await authority.command(code, token, { id: 'day', command: { type: 'advance', toMinute: 1440 } });
  expect(day.code).toBe('OK');
  await authority.command(code, token, { id: 'b1', command: { type: 'buy', item: 'bomb' } });
  events.length = 0;
  const bomb = await authority.command(code, token, { id: 'boom', command: { type: 'apply', tool: 'bomb', x: 30, y: 30 } });
  expect(bomb.code).toBe('OK');
  const fx = events.find(event => event.type === 'fx');
  expect(fx).toMatchObject({ type: 'fx', tool: 'bomb', x: 30, y: 30, id: 'boom' });
  expect(events.findIndex(event => event.type === 'fx')).toBeLessThan(events.findIndex(event => event.type === 'tile'));
  // Ordinary brush strokes do not announce an effect.
  events.length = 0;
  await authority.command(code, token, { id: 'brush', command: { type: 'apply', tool: 'brush', x: 60, y: 60 } });
  expect(events.some(event => event.type === 'fx')).toBe(false);
});
