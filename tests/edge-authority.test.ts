import { expect, test } from 'vitest';
import { createEdgeAuthority } from '../src/edge/authority';
import { MemoryKV, type EdgeKV } from '../src/edge/kv';
import { tileOf, type EdgeEvent, type TileRecord } from '../src/edge/types';
import type { Command } from '../src/game/types';
import { acceptanceDataset } from './fixtures/room-roster';
import { COST } from '../src/game/rules';

const dataset = acceptanceDataset();
const ids = dataset.players.map(p => p.id);
const [host, teammate, rival] = [ids[0], ids[1], ids[3]];
function seeded(seed: number) { return () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; }; }

async function setup(kv: EdgeKV = new MemoryKV()) {
  const events: EdgeEvent[] = [];
  const authority = createEdgeAuthority({ kv, publish: async (_room, event) => { events.push(event); } });
  const room = await authority.createRoom({ name: 'Edge', hostId: host, dataset });
  const sessions = new Map<string, string>();
  for (const invite of room.invites) sessions.set(invite.playerId, (await authority.join(room.code, { inviteCode: invite.code })).session.token);
  const run = (player: string, id: string, command: Command) => authority.command(room.code, sessions.get(player), { id, command });
  return { authority, room, sessions, run, events, kv };
}
const paint = (x: number, y = 0): Command => ({ type: 'apply', tool: 'brush', x, y });

test('edge rooms keep the paint rules, private wallets and one shared board', async () => {
  const { authority, room, sessions, run, events } = await setup();
  expect((await run(host, 'a', paint(0))).wallet.state.spent).toBe(COST.brush);
  const capture = await run(rival, 'b', paint(0));
  expect(capture.code).toBe('OK'); expect(capture.wallet.state.spent).toBe(COST.rival);
  expect((await run(rival, 'c', paint(0))).code).toBe('NO_CHANGE');
  expect((await run(teammate, 'd', paint(0))).wallet.state.spent).toBe(COST.rival);
  // Shields protect own-team cells from rivals and cost nothing to place once bought.
  expect((await run(teammate, 'buy', { type: 'buy', item: 'shield' })).wallet.state.spent).toBe(COST.rival + COST.shield);
  const shield = await run(teammate, 'shield', { type: 'apply', tool: 'shield', x: 0, y: 0 });
  expect(shield.changed).toEqual([0]); expect(shield.wallet.state.inventory.shield).toBe(0);
  expect((await run(rival, 'blocked', paint(0))).code).toBe('NO_CHANGE');
  // Only the host moves time; credits derive from the shared clock.
  expect((await run(rival, 'tick', { type: 'advance', toMinute: 1440 })).code).toBe('HOST_ONLY');
  const advanced = await run(host, 'tick', { type: 'advance', toMinute: 1440 });
  expect(advanced.code).toBe('OK'); expect(advanced.clock.minute).toBe(1440);
  expect(events.some(e => e.type === 'clock' && e.minute === 1440)).toBe(true);
  const views = await Promise.all(ids.map(id => authority.view(room.code, sessions.get(id))));
  for (const view of views) {
    expect(view.state.cells).toEqual(views[0].state.cells);
    expect(view.state.balance).toBe(view.state.earned - view.state.spent);
    expect(view.state.earned).toBe(40000);
    expect(view.dataset.players.map(p => p.id)).toEqual([view.state.playerId]);
  }
  expect(views[0].state.cells[0]).toEqual({ owner: 'team-0', shieldUntil: 120 });
  expect(views[0].members.every(member => member.joined)).toBe(true);
  expect(JSON.stringify(events)).not.toMatch(/spent|balance|inventory|days/);
  await expect(authority.view(room.code, 'x'.repeat(32))).rejects.toThrow('session');
});

test('retries under the same ID charge once; a changed payload is refused', async () => {
  const { run } = await setup();
  const first = await run(host, 'same', { type: 'buy', item: 'bomb' });
  const again = await run(host, 'same', { type: 'buy', item: 'bomb' });
  expect([first.wallet.state.spent, again.wallet.state.spent]).toEqual([COST.bomb, COST.bomb]);
  expect(again.wallet.state.inventory.bomb).toBe(1);
  await expect(run(host, 'same', { type: 'buy', item: 'shield' })).rejects.toThrow('different command');
  const both = await Promise.all([run(host, 'twin', paint(5)), run(host, 'twin', paint(5))]);
  expect(both.map(r => r.wallet.state.spent)).toEqual([COST.bomb + COST.brush, COST.bomb + COST.brush]);
});

test('a request that dies after reserving paint is finished by the next request, exactly once', async () => {
  const memory = new MemoryKV();
  let crash = false;
  const kv: EdgeKV = { get: k => memory.get(k), put: (k, v) => memory.put(k, v), delete: k => memory.delete(k), list: p => memory.list(p),
    add: async (k, v) => { if (crash && k.includes('/t/')) throw new Error('instance lost'); return memory.add(k, v); } };
  const { run, authority, room, sessions } = await setup(kv);
  crash = true;
  await expect(run(host, 'lost', paint(1))).rejects.toThrow('instance lost');
  crash = false;
  const next = await run(host, 'next', paint(2));
  expect(next.wallet.state.spent).toBe(2 * COST.brush);
  const retried = await run(host, 'lost', paint(1));
  expect(retried.code).toBe('OK'); expect(retried.wallet.state.spent).toBe(2 * COST.brush);
  const view = await authority.view(room.code, sessions.get(host));
  expect([view.state.cells[1].owner, view.state.cells[2].owner]).toEqual(['team-0', 'team-0']);
});

test.each([7, 11, 23])('23 players racing on shared tiles with stale reads conserve every paint unit (seed %i)', async seed => {
  const random = seeded(seed);
  const memory = new MemoryKV(random, () => new Promise(resolve => setTimeout(resolve, Math.floor(random() * 3))));
  const { run, authority, room, sessions } = await setup(memory);
  memory.staleness = 0.3;
  const bought = new Map<string, number>();
  for (let round = 0; round < 12; round++) {
    await Promise.all(ids.map((player, p) => {
      const x = Math.floor(random() * 14), y = Math.floor(random() * 3);
      const pick = random();
      const command: Command = pick < 0.15 ? { type: 'buy', item: 'bomb' }
        : pick < 0.3 ? { type: 'apply', tool: 'bomb', x, y }
        : pick < 0.5 ? { type: 'apply', tool: 'brush', x, y, shape: 'circle' }
        : { type: 'stroke', points: Array.from({ length: 6 }, (_, i) => ({ x: (x + i) % 14, y })) };
      // Some players also send the same request twice at once (a retry racing its original).
      const twice = random() < 0.25;
      return Promise.all([run(player, `r${round}p${p}`, command), twice ? run(player, `r${round}p${p}`, command) : undefined]).then(([reply]) => {
        if (command.type === 'buy' && reply.code === 'OK') bought.set(player, (bought.get(player) ?? 0) + 1);
      });
    }));
  }
  memory.staleness = 0; memory.settle();
  expect(memory.conflicts).toBeGreaterThan(0);
  // Every tile version's newest `applied` entry is one command; none may be applied twice.
  const costs = new Map<string, number>(); const seen = new Set<string>();
  for (const [k, value] of memory.data) {
    if (!/\/t\/\d+\/\d+$/.test(k)) continue;
    const entry = (JSON.parse(value) as TileRecord).applied.at(-1)!;
    const tile = k.split('/')[3];
    expect(seen.has(`${tile}:${entry.key}`)).toBe(false); seen.add(`${tile}:${entry.key}`);
    const player = entry.key.slice(0, entry.key.lastIndexOf(':'));
    costs.set(player, (costs.get(player) ?? 0) + entry.cost);
    for (const index of entry.cells) expect(tileOf(index)).toBe(Number(tile));
  }
  const views = await Promise.all(ids.map(id => authority.view(room.code, sessions.get(id))));
  for (const view of views) {
    const player = view.state.playerId;
    expect(view.state.cells).toEqual(views[0].state.cells);
    expect(view.state.balance).toBe(view.state.earned - view.state.spent);
    expect(view.state.balance).toBeGreaterThanOrEqual(0);
    // Money conservation: spend equals purchases plus the paint actually applied to tiles.
    expect(view.state.spent).toBe((bought.get(player) ?? 0) * COST.bomb + (costs.get(player) ?? 0));
  }
}, 30000);

test('the host cannot move the shared clock past the last day with step data', async () => {
  const { run } = await setup();
  expect((await run(host, 'last', { type: 'advance', toMinute: 1440 })).code).toBe('OK');
  expect((await run(host, 'inside', { type: 'advance', toMinute: 2879 })).code).toBe('OK');
  const beyond = await run(host, 'beyond', { type: 'advance', toMinute: 2880 });
  expect(beyond.code).toBe('NO_MORE_DAYS');
  expect(beyond.clock.minute).toBe(2879);
});
