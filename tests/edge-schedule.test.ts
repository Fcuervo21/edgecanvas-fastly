import { expect, test } from 'vitest';
import { createEdgeAuthority } from '../src/edge/authority';
import { MemoryKV } from '../src/edge/kv';
import type { EdgeEvent } from '../src/edge/types';
import { acceptanceDataset } from './fixtures/room-roster';

const DAY = 86_400_000;
const dataset = acceptanceDataset(5);
const [host, other] = [dataset.players[0].id, dataset.players[1].id];
// Tuesday 2026-10-06, 12:00 UTC.
const T0 = Date.UTC(2026, 9, 6, 12);

async function setup() {
  let now = T0;
  const events: EdgeEvent[] = [];
  const authority = createEdgeAuthority({ kv: new MemoryKV(), now: () => now, publish: async (_room, event) => { events.push(event); } });
  const room = await authority.createRoom({ name: 'Edge', hostId: host, dataset }, { invites: false });
  return { authority, code: room.code, events, at: (ms: number) => { now = ms; } };
}
const minuteOf = async (s: Awaited<ReturnType<typeof setup>>, player = other) => (await s.authority.viewAs(s.code, player)).state.minute;

test('rooms start on manual days: no schedule until the host sets one', async () => {
  const s = await setup();
  expect((await s.authority.viewAs(s.code, host)).autoAdvance).toBeNull();
  s.at(T0 + 5 * DAY);
  expect(await minuteOf(s)).toBe(0);
});

test('the host schedules a daily change; the first one is the next time that minute of the day comes round', async () => {
  const s = await setup();
  const view = await s.authority.setSchedule(s.code, host, { at: 21 * 60 });      // 21:00 UTC
  expect(view.autoAdvance).toEqual({ at: 21 * 60, next: Date.UTC(2026, 9, 6, 21) });
  const later = await s.authority.setSchedule(s.code, host, { at: 6 * 60 });      // 06:00 UTC has passed today
  expect(later.autoAdvance).toEqual({ at: 6 * 60, next: Date.UTC(2026, 9, 7, 6) });
});

test('only the host can change the schedule, and bad times are refused', async () => {
  const s = await setup();
  await expect(s.authority.setSchedule(s.code, other, { at: 60 })).rejects.toMatchObject({ status: 403 });
  for (const at of [-1, 1440, 1.5, Number.NaN, '600']) await expect(s.authority.setSchedule(s.code, host, { at } as never)).rejects.toMatchObject({ status: 400 });
});

test('the day changes by itself once the time passes, for everyone, and is announced', async () => {
  const s = await setup();
  await s.authority.setSchedule(s.code, host, { at: 21 * 60 });
  s.at(Date.UTC(2026, 9, 6, 20, 59));
  expect(await minuteOf(s)).toBe(0);
  s.at(Date.UTC(2026, 9, 6, 21, 1));
  const view = await s.authority.viewAs(s.code, other);
  expect(view.state.minute).toBe(1440);
  expect(view.state.earned).toBe(40000);                       // the second day's steps are credited
  expect(view.autoAdvance!.next).toBe(Date.UTC(2026, 9, 7, 21));
  expect(s.events.filter(e => e.type === 'clock').at(-1)).toMatchObject({ minute: 1440 });
  expect(await minuteOf(s, host)).toBe(1440);                  // not advanced a second time
});

test('several viewers arriving at once move the day only once', async () => {
  const s = await setup();
  await s.authority.setSchedule(s.code, host, { at: 21 * 60 });
  s.at(Date.UTC(2026, 9, 6, 22));
  const minutes = await Promise.all([host, other, host, other].map(player => s.authority.viewAs(s.code, player).then(v => v.state.minute)));
  expect(minutes).toEqual([1440, 1440, 1440, 1440]);
});

test('missed days are caught up, but never past the last day with step data', async () => {
  const s = await setup();
  await s.authority.setSchedule(s.code, host, { at: 21 * 60 });
  s.at(Date.UTC(2026, 9, 8, 22));                              // the 6th, 7th and 8th at 21:00 have passed
  expect(await minuteOf(s)).toBe(3 * 1440);
  s.at(Date.UTC(2026, 9, 30, 22));
  expect(await minuteOf(s)).toBe(4 * 1440);                    // five recorded days: day 5 is the last
});

test('a command after the time passes sees the new day, and manual advances keep the schedule', async () => {
  const s = await setup();
  await s.authority.setSchedule(s.code, host, { at: 21 * 60 });
  s.at(Date.UTC(2026, 9, 6, 22));
  const reply = await s.authority.commandAs(s.code, other, { id: 'p', command: { type: 'apply', tool: 'brush', x: 1, y: 1 } });
  expect(reply.clock.minute).toBe(1440);
  await s.authority.commandAs(s.code, host, { id: 'manual', command: { type: 'advance', toMinute: 2 * 1440 } });
  const view = await s.authority.viewAs(s.code, host);
  expect(view.state.minute).toBe(2 * 1440);
  expect(view.autoAdvance).not.toBeNull();
});

test('turning the schedule off stops it', async () => {
  const s = await setup();
  await s.authority.setSchedule(s.code, host, { at: 21 * 60 });
  const off = await s.authority.setSchedule(s.code, host, { at: null });
  expect(off.autoAdvance).toBeNull();
  s.at(T0 + 3 * DAY);
  expect(await minuteOf(s)).toBe(0);
});

// Day results: who led when each day closed.
const teamOf = (id: string) => dataset.players.find(p => p.id === id)!.team;
const paint = (s: Awaited<ReturnType<typeof setup>>, player: string, id: string, x: number, y = 0) =>
  s.authority.commandAs(s.code, player, { id, command: { type: 'apply', tool: 'brush', x, y } });

test('closing a day records the team leading at that moment, from a manual or an automatic change', async () => {
  const s = await setup();
  const [a1, a2, b1] = [dataset.players[0].id, dataset.players[1].id, dataset.players[3].id];
  await paint(s, a1, 'p1', 0); await paint(s, a2, 'p2', 1); await paint(s, b1, 'p3', 2);
  expect((await s.authority.viewAs(s.code, a1)).days).toEqual([]);
  await s.authority.commandAs(s.code, host, { id: 'd1', command: { type: 'advance', toMinute: 1440 } });
  await paint(s, b1, 'p4', 3); await paint(s, b1, 'p5', 4);                       // B now leads 3 to 2
  await s.authority.setSchedule(s.code, host, { at: 21 * 60 });
  s.at(Date.UTC(2026, 9, 6, 22));
  const view = await s.authority.viewAs(s.code, other);
  expect(view.state.minute).toBe(2 * 1440);
  expect(view.days).toEqual([{ day: 0, team: teamOf(a1), pixels: 2 }, { day: 1, team: teamOf(b1), pixels: 3 }]);
});

test('a jump over several days gives each of them the standing the board had, and results are never lost by later changes', async () => {
  const s = await setup();
  await paint(s, dataset.players[0].id, 'p1', 0);
  await s.authority.commandAs(s.code, host, { id: 'jump', command: { type: 'advance', toMinute: 3 * 1440 } });
  const team = teamOf(dataset.players[0].id);
  expect((await s.authority.viewAs(s.code, host)).days).toEqual([0, 1, 2].map(day => ({ day, team, pixels: 1 })));
  await s.authority.setSchedule(s.code, host, { at: 60 });
  await s.authority.commandAs(s.code, host, { id: 'minutes', command: { type: 'advance', toMinute: 3 * 1440 + 10 } });
  expect((await s.authority.viewAs(s.code, other)).days).toHaveLength(3);        // a schedule change or moving minutes closes no day
});

test('the reply to a command carries the results too, so the player who triggered a day change is up to date at once', async () => {
  const s = await setup();
  await paint(s, dataset.players[0].id, 'p1', 0);
  await s.authority.setSchedule(s.code, host, { at: 21 * 60 });
  s.at(Date.UTC(2026, 9, 6, 22));
  const reply = await paint(s, other, 'p2', 5);
  expect(reply.clock.days).toEqual([{ day: 0, team: teamOf(dataset.players[0].id), pixels: 1 }]);
});
