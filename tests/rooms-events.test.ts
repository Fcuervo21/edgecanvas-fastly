import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoomService, EVENT_RETENTION } from '../server/service';
import type { RoomEvent } from '../src/rooms/types';
import { acceptanceDataset } from './fixtures/room-roster';
import { COST } from '../src/game/rules';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const dataset = acceptanceDataset();
const [hostId, rivalId] = [dataset.players[0].id, dataset.players[3].id];

function open(options: Partial<Parameters<typeof createRoomService>[0]> = {}) {
  const service = createRoomService({ dataset, databasePath: ':memory:', ...options });
  cleanup.push(() => service.close());
  const host = service.create({ name: 'Events', hostId });
  const rivalInvite = host.invites!.find(invite => invite.playerId === rivalId)!.code;
  return { service, host, code: host.session.code, rivalInvite };
}
const paint = (id: string, x: number, y = 0) => ({ id, command: { type: 'apply' as const, tool: 'brush' as const, x, y } });

test('committed changes append ordered public events without personal data', () => {
  const { service, host, code, rivalInvite } = open();
  const rival = service.join(code, { inviteCode: rivalInvite });
  service.command(code, host.session.token, paint('a', 1));
  service.command(code, rival.session.token, paint('b', 1));
  service.command(code, host.session.token, { id: 'buy', command: { type: 'buy', item: 'bomb' } });
  service.command(code, host.session.token, paint('noop', 1, 99_999));
  const replay = service.events(code, host.session.token, 1);
  expect('events' in replay).toBe(true);
  const events = (replay as { events: RoomEvent[] }).events;
  expect(events.map(event => event.revision)).toEqual([2, 3, 4, 5]);
  expect(events[0]).toEqual({ revision: 2, minute: 0, cells: [], rosterChanged: true });
  expect(events[1].cells).toEqual([{ index: 1, owner: 'team-0', shieldUntil: 0 }]);
  expect(events[2].cells).toEqual([{ index: 1, owner: 'team-1', shieldUntil: 0 }]);
  // A purchase changes a private wallet only; the public event carries no balance or inventory.
  expect(events[3]).toEqual({ revision: 5, minute: 0, cells: [], rosterChanged: false });
  const text = JSON.stringify(events);
  for (const secret of ['balance', 'spent', 'earned', 'inventory', 'days', host.session.token, rivalInvite]) expect(text).not.toContain(secret);
  expect(service.events(code, host.session.token, 5)).toEqual({ events: [] });
});

test('replays require a room session and send a reset once history is no longer retained', () => {
  const { service, host, code } = open();
  expect(() => service.events(code, 'not-a-session', 0)).toThrow('session');
  for (let i = 0; i < EVENT_RETENTION + 5; i++) service.command(code, host.session.token, { id: `p${i}`, command: { type: 'apply', tool: 'brush', x: i % 100, y: Math.floor(i / 100) } });
  const current = EVENT_RETENTION + 6;
  expect(service.events(code, host.session.token, 1)).toEqual({ reset: true, revision: current });
  const recent = service.events(code, host.session.token, current - 3) as { events: RoomEvent[] };
  expect(recent.events.map(event => event.revision)).toEqual([current - 2, current - 1, current]);
  // Pruning events never forgets command receipts: retrying an old ID is not a second purchase.
  const repeat = service.command(code, host.session.token, { id: 'p0', command: { type: 'apply', tool: 'brush', x: 0, y: 0 } });
  expect(repeat.view.revision).toBe(current);
});

test('watchers wake only after commit and a failed publisher never repeats or undoes a spend', async () => {
  let fail = true; const published: number[] = [];
  const { service, host, code } = open({ publish: async (_room, event) => { if (fail) throw new Error('publisher down'); published.push(event.revision); } });
  const woke: number[] = [];
  const unwatch = service.watch(code, () => woke.push((service.view(code, host.session.token) as { revision: number }).revision));
  const reply = service.command(code, host.session.token, { id: 'buy', command: { type: 'buy', item: 'bomb' } });
  expect(reply.code).toBe('OK'); expect(reply.view.state.spent).toBe(COST.bomb);
  expect(woke).toEqual([2]);
  await service.flushOutbox();
  expect(service.pendingPublications()).toBe(1);
  fail = false;
  await service.flushOutbox(); await service.flushOutbox();
  expect(published).toEqual([2]);
  expect(service.pendingPublications()).toBe(0);
  const retry = service.command(code, host.session.token, { id: 'buy', command: { type: 'buy', item: 'bomb' } });
  expect(retry.view.state.spent).toBe(COST.bomb); expect(retry.view.state.inventory.bomb).toBe(1);
  await service.flushOutbox();
  expect(published).toEqual([2]);
  unwatch();
  service.command(code, host.session.token, paint('after', 5));
  expect(woke).toEqual([2]);
});

test('events and pending publications survive a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-events-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'rooms.sqlite');
  const first = createRoomService({ dataset, databasePath, publish: async () => { throw new Error('down'); } });
  const host = first.create({ name: 'Durable', hostId });
  first.command(host.session.code, host.session.token, paint('a', 3));
  await first.flushOutbox(); first.close();
  const published: number[] = [];
  const second = createRoomService({ dataset, databasePath, publish: async (_room, event) => { published.push(event.revision); } });
  cleanup.push(() => second.close());
  expect(second.pendingPublications()).toBe(1);
  await second.flushOutbox();
  expect(published).toEqual([2]);
  expect((second.events(host.session.code, host.session.token, 1) as { events: RoomEvent[] }).events[0].cells).toEqual([{ index: 3, owner: 'team-0', shieldUntil: 0 }]);
});

test('account members replay events; outsiders and disabled accounts cannot', async () => {
  const service = createRoomService({ dataset, databasePath: ':memory:', accessMode: 'accounts' }); cleanup.push(() => service.close());
  const auth = service.accounts!;
  const register = (index: number, organizer = false) => auth.register({ username: `player${index}`, password: 'Synthetic canvas password!', enrollment: auth.enroll(dataset.players[index].id, organizer).code }, 'test');
  const host = await register(0, true), member = await register(3);
  const view = auth.createRoom(host.token, { name: 'Account events' });
  auth.commandRoom(host.token, view.code, paint('a', 7));
  expect((auth.eventsRoom(member.token, view.code, 1) as { events: RoomEvent[] }).events.map(event => event.revision)).toEqual([2]);
  expect(() => service.events(view.code, 'anything', 0)).toThrow();
  auth.disable(host.token, member.account.id);
  expect(() => auth.eventsRoom(member.token, view.code, 1)).toThrow('Sign in');
}, 15000);
