import { expect, test, vi } from 'vitest';
import { createEdgeApp } from '../src/edge/app';
import { MemoryKV } from '../src/edge/kv';
import type { EdgeView } from '../src/edge/types';
import { connectEdgeRoom, mergeTiles, mergeView } from '../src/rooms/edge-client';
import { acceptanceDataset } from './fixtures/room-roster';
import { COST } from '../src/game/rules';

const ORIGIN = 'https://edge.example', ADMIN = 'a'.repeat(40);
const dataset = acceptanceDataset();

async function room() {
  const app = createEdgeApp({ kv: new MemoryKV(), adminToken: ADMIN, pepper: 'p', iterations: 2 });
  const send = (path: string, init: RequestInit & { cookie?: string } = {}) => app.handle(new Request(`${ORIGIN}${path}`,
    { ...init, headers: { origin: ORIGIN, ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string>) } }));
  await send('/api/admin/dataset', { method: 'PUT', headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify(dataset) });
  async function person(playerId: string, username: string, organizer = false) {
    const { code } = await (await send('/api/admin/enroll', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ playerId, organizer }) })).json();
    const response = await send('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password: 'a long enough passphrase 123', enrollment: code }) });
    const cookie = response.headers.get('set-cookie')!.split(';')[0], { csrfToken } = await response.json();
    /** A browser `fetch` for this person: same-origin cookie and Origin header. */
    const browser = (async (url: string | URL | Request, init: RequestInit = {}) => send(String(url), { ...init, cookie })) as typeof fetch;
    return { cookie, csrfToken, browser };
  }
  const host = await person(dataset.players[0].id, 'host', true), guest = await person(dataset.players[3].id, 'guest');
  const view = await (await send('/api/rooms', { method: 'POST', cookie: host.cookie, headers: { 'x-csrf-token': host.csrfToken }, body: JSON.stringify({ name: 'Splash' }) })).json() as EdgeView;
  await send(`/api/rooms/${view.code}/join`, { method: 'POST', cookie: guest.cookie, headers: { 'x-csrf-token': guest.csrfToken }, body: '{}' });
  const open = async (who: typeof host) => (await who.browser(`/api/rooms/${view.code}`)).json() as Promise<EdgeView>;
  return { host, guest, code: view.code, open };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10)); expect(check()).toBe(true); };

test('two players see each other through the edge client; wallets stay private', async () => {
  const { host, guest, code, open } = await room();
  const views: Record<string, EdgeView> = {};
  const hostClient = connectEdgeRoom({ code, csrfToken: host.csrfToken }, await open(host), { view: v => { views.host = v as EdgeView; }, status: () => {} }, host.browser);
  const guestClient = connectEdgeRoom({ code, csrfToken: guest.csrfToken }, await open(guest), { view: v => { views.guest = v as EdgeView; }, status: () => {} }, guest.browser);
  hostClient.submit({ type: 'advance', toMinute: 1440 });
  await until(() => views.host?.state.minute === 1440);
  guestClient.submit({ type: 'apply', tool: 'brush', x: 10, y: 10 });
  // The painter's own screen updates at once; wait for the server's confirmation (wallet version 2) before other screens can have it.
  await until(() => views.guest?.state.cells[1010].owner === 'team-1' && views.guest.edge.wallet >= 2);
  expect(views.guest.state.spent).toBe(COST.brush);
  await hostClient.poll();
  expect(views.host.state.cells[1010].owner).toBe('team-1');
  expect(views.host.state.spent).toBe(0);
  hostClient.stop(); guestClient.stop();
});

test('a lost response is retried under the same ID and charged once', async () => {
  const { guest, code, open } = await room();
  let drop = true;
  const flaky = (async (url, init) => {
    const response = await guest.browser(url, init);
    if (drop && String(url).endsWith('/commands')) { drop = false; throw new TypeError('network lost'); }
    return response;
  }) as typeof fetch;
  let latest: EdgeView | undefined;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const client = connectEdgeRoom({ code, csrfToken: guest.csrfToken }, await open(guest), { view: v => { latest = v as EdgeView; }, status: () => {} }, flaky);
  client.submit({ type: 'buy', item: 'bomb' });
  await vi.advanceTimersByTimeAsync(2000);
  vi.useRealTimers();
  await until(() => latest?.state.inventory.bomb === 1);
  expect(latest!.state.spent).toBe(COST.bomb);
  client.stop();
});

test('stale snapshots never roll back newer tiles or wallets', async () => {
  const { guest, open } = await room();
  const view = await open(guest), old = structuredClone(view);
  mergeTiles(view, [{ tile: 0, version: 3, cells: Array.from({ length: 100 }, () => ['team-9', 0] as [string, number]) }]);
  view.edge.wallet = 5; view.state.spent = 700;
  expect(mergeView(view, old)).toEqual([]);
  expect(view.state.cells[0].owner).toBe('team-9');
  expect(view.state.spent).toBe(700);
});

test('without live pushes the browser skips the stream and refreshes every 10 seconds', async () => {
  const { guest, code, open } = await room();
  const calls: string[] = [];
  const spy = (async (url, init) => { calls.push(String(url)); return guest.browser(url, init); }) as typeof fetch;
  vi.useFakeTimers({ shouldAdvanceTime: false });
  const initial = { ...(await open(guest)), live: false } as EdgeView;
  const client = connectEdgeRoom({ code, csrfToken: guest.csrfToken }, initial, { view: () => {}, status: () => {} }, spy, { live: true });
  await vi.advanceTimersByTimeAsync(6000);
  expect(calls.filter(u => u.endsWith(`/api/rooms/${code}`))).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(5000);
  expect(calls.filter(u => u.endsWith(`/api/rooms/${code}`)).length).toBeGreaterThanOrEqual(1);
  expect(calls.some(u => u.endsWith('/events'))).toBe(false);
  client.stop(); vi.useRealTimers();
});

test('a hidden tab stops refreshing and catches up as soon as it is shown again', async () => {
  const { guest, code, open } = await room();
  const calls: string[] = [];
  const spy = (async (url, init) => { calls.push(String(url)); return guest.browser(url, init); }) as typeof fetch;
  const listeners = new Map<string, () => void>(), page = { hidden: true, addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) };
  vi.stubGlobal('document', page);
  vi.useFakeTimers({ shouldAdvanceTime: false });
  const client = connectEdgeRoom({ code, csrfToken: guest.csrfToken }, await open(guest), { view: () => {}, status: () => {} }, spy);
  await vi.advanceTimersByTimeAsync(20000);
  const views = () => calls.filter(u => u.endsWith(`/api/rooms/${code}`)).length;
  expect(views()).toBe(0);
  page.hidden = false; listeners.get('visibilitychange')!();
  await vi.advanceTimersByTimeAsync(100);
  expect(views()).toBeGreaterThanOrEqual(1);
  client.stop(); vi.useRealTimers(); vi.unstubAllGlobals();
});

test('painting shows instantly on your own screen while the server catches up', async () => {
  const { guest, code, open } = await room();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const slow = (async (url, init) => { if (String(url).endsWith('/commands')) await gate; return guest.browser(url, init); }) as typeof fetch;
  let latest: EdgeView | undefined;
  const client = connectEdgeRoom({ code, csrfToken: guest.csrfToken }, await open(guest), { view: v => { latest = v as EdgeView; }, status: () => {} }, slow);
  client.submit({ type: 'stroke', points: [{ x: 10, y: 10 }, { x: 11, y: 10 }] });
  // No server answer yet, and the cells and the price are already on screen.
  expect(latest!.state.cells[1010].owner).toBe('team-1'); expect(latest!.state.cells[1011].owner).toBe('team-1');
  expect(latest!.state.spent).toBe(2 * COST.brush);
  release();
  await until(() => (latest?.edge.wallet ?? 0) >= 2);
  // Once confirmed the price is charged once, not twice.
  expect(latest!.state.spent).toBe(2 * COST.brush); expect(latest!.state.cells[1010].owner).toBe('team-1');
  client.stop();
});

test('strokes drawn while a request is in flight travel together in the next one', async () => {
  const { guest, code, open } = await room();
  const bodies: { id: string; command: { type: string; points: unknown[] } }[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = (async (url, init) => {
    if (String(url).endsWith('/commands')) { bodies.push(JSON.parse(String(init!.body))); if (bodies.length === 1) await gate; }
    return guest.browser(url, init);
  }) as typeof fetch;
  let latest: EdgeView | undefined;
  const client = connectEdgeRoom({ code, csrfToken: guest.csrfToken }, await open(guest), { view: v => { latest = v as EdgeView; }, status: () => {} }, spy);
  const stroke = (from: number, length: number) => ({ type: 'stroke' as const, points: Array.from({ length }, (_, i) => ({ x: from + i, y: 20 })) });
  client.submit(stroke(0, 1));       // goes out right away
  client.submit(stroke(10, 2)); client.submit(stroke(20, 3)); client.submit(stroke(30, 1));  // wait behind it
  release();
  await until(() => (latest?.edge.wallet ?? 0) >= 4);
  expect(bodies).toHaveLength(2);
  expect(bodies[1].command.points).toHaveLength(6);
  expect(Object.keys(bodies[1])).toEqual(['id', 'command']);   // nothing extra reaches the server
  expect(latest!.state.spent).toBe(7 * COST.brush);
  client.stop();
});

test('own predicted cells are reported apart from cells changed by others', async () => {
  const { guest, code, open } = await room();
  const seen: { changed: number[]; local: number[] | undefined }[] = [];
  const client = connectEdgeRoom({ code, csrfToken: guest.csrfToken }, await open(guest), { view: (_v, changed, local) => { seen.push({ changed: changed ?? [], local }); }, status: () => {} }, guest.browser);
  client.submit({ type: 'stroke', points: [{ x: 10, y: 10 }, { x: 11, y: 10 }] });
  expect(seen.at(-1)!.local).toEqual([1010, 1011]);
  expect(seen.at(-1)!.changed).toEqual([]);
  client.stop();
});

test('a burst of strokes does not flood the screen with updates', async () => {
  const { guest, code, open } = await room();
  let updates = 0;
  const client = connectEdgeRoom({ code, csrfToken: guest.csrfToken }, await open(guest), { view: () => { updates++; }, status: () => {} }, guest.browser);
  for (let i = 0; i < 200; i++) client.submit({ type: 'stroke', points: [{ x: i % 100, y: 30 + Math.floor(i / 100) }] });
  expect(updates).toBeLessThanOrEqual(3);
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(updates).toBeLessThanOrEqual(6);
  client.stop();
});

test('effects announced by other players reach the screen, but your own do not repeat', async () => {
  const { guest, code, open } = await room();
  const encoder = new TextEncoder();
  let push!: (text: string) => void;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { push = text => controller.enqueue(encoder.encode(text)); push('retry: 3000\n\n'); } });
  const request = (async (url, init) => String(url).endsWith('/events')
    ? new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }) : guest.browser(url, init)) as typeof fetch;
  const effects: { id: string; tool: string }[] = [];
  vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('11111111-1111-4111-8111-111111111111');
  const initial = { ...(await open(guest)), live: true } as EdgeView;
  const client = connectEdgeRoom({ code, csrfToken: guest.csrfToken }, initial, { view: () => {}, status: () => {}, effect: fx => { effects.push(fx); } }, request, { live: true });
  client.submit({ type: 'buy', item: 'bomb' });   // this command gets the id above
  const fx = (id: string) => `event: fx\ndata: ${JSON.stringify({ type: 'fx', tool: 'bomb', x: 30, y: 30, team: 'team-2', id })}\n\n`;
  push(fx('someone-else')); push(fx('11111111-1111-4111-8111-111111111111'));
  await until(() => effects.length >= 1);
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(effects.map(e => e.id)).toEqual(['someone-else']);
  client.stop(); vi.restoreAllMocks();
});

/** A room whose commands never answer, and whose snapshots we control, to reproduce what the server does mid-save. */
async function frozenRoom() {
  const { guest, code, open } = await room();
  const initial = await open(guest);
  let snapshot: EdgeView = structuredClone(initial);
  const request = (async (url, init) => {
    if (String(url).endsWith('/commands')) return new Promise<Response>(() => {});   // saved on the server, answer not back yet
    if (String(url) === `/api/rooms/${code}`) return new Response(JSON.stringify(snapshot), { status: 200, headers: { 'content-type': 'application/json' } });
    return guest.browser(url, init);
  }) as typeof fetch;
  let latest: EdgeView | undefined;
  const client = connectEdgeRoom({ code, csrfToken: guest.csrfToken }, initial, { view: v => { latest = v as EdgeView; }, status: () => {} }, request);
  return { client, initial, snapshot: (next: EdgeView) => { snapshot = next; }, latest: () => latest!, code };
}
const stroke = { type: 'stroke' as const, points: [{ x: 10, y: 10 }, { x: 11, y: 10 }] };   // two new pixels: twice the brush price

test('the paint counter is not charged twice when a snapshot already holds the reserved price', async () => {
  const { client, initial, snapshot, latest } = await frozenRoom();
  client.submit(stroke);
  expect(latest().state.balance).toBe(initial.state.balance - 2 * COST.brush);
  // The server has reserved the price (wallet version 1) but has not saved the tiles yet.
  const mid = structuredClone(initial); mid.edge.wallet = 1; mid.state.spent = 2 * COST.brush; mid.state.balance = initial.state.balance - 2 * COST.brush;
  snapshot(mid); await client.poll();
  expect(latest().state.balance).toBe(initial.state.balance - 2 * COST.brush);
  expect(latest().state.spent).toBe(2 * COST.brush);
  client.stop();
});

test('the paint counter does not jump back up when the saved pixels arrive before the answer', async () => {
  const { client, initial, snapshot, latest } = await frozenRoom();
  client.submit(stroke);
  // The pixels are already saved and announced, but the wallet you see is still the old one.
  const saved = structuredClone(initial);
  for (const index of [1010, 1011]) saved.state.cells[index] = { owner: 'team-1', shieldUntil: 0 };
  saved.edge.tiles[11] = 1;
  snapshot(saved); await client.poll();
  expect(latest().state.cells[1010].owner).toBe('team-1');
  expect(latest().state.balance).toBe(initial.state.balance - 2 * COST.brush);
  client.stop();
});

test('the host schedules automatic days from the client, and everyone else learns of it on their next refresh', async () => {
  const { host, guest, code, open } = await room();
  const views: Record<string, EdgeView> = {};
  const hostClient = connectEdgeRoom({ code, csrfToken: host.csrfToken }, await open(host), { view: v => { views.host = v as EdgeView; }, status: () => {} }, host.browser);
  const guestClient = connectEdgeRoom({ code, csrfToken: guest.csrfToken }, await open(guest), { view: v => { views.guest = v as EdgeView; }, status: () => {} }, guest.browser);
  expect(await hostClient.schedule(600)).toBe(true);
  expect(views.host.autoAdvance).toMatchObject({ at: 600 });
  await guestClient.poll();
  expect(views.guest.autoAdvance).toMatchObject({ at: 600 });
  expect(await guestClient.schedule(0)).toBe(false);          // only the host may
  expect(views.guest.autoAdvance).toMatchObject({ at: 600 });
  expect(await hostClient.schedule(null)).toBe(true);
  expect(views.host.autoAdvance).toBeNull();
  hostClient.stop(); guestClient.stop();
});

test('day results reach every screen: from the answer to your own day change and from the next refresh for everyone else', async () => {
  const { host, guest, code, open } = await room();
  const views: Record<string, EdgeView> = {};
  const hostClient = connectEdgeRoom({ code, csrfToken: host.csrfToken }, await open(host), { view: v => { views.host = v as EdgeView; }, status: () => {} }, host.browser);
  const guestClient = connectEdgeRoom({ code, csrfToken: guest.csrfToken }, await open(guest), { view: v => { views.guest = v as EdgeView; }, status: () => {} }, guest.browser);
  guestClient.submit({ type: 'apply', tool: 'brush', x: 10, y: 10 });
  await until(() => (views.guest?.edge.wallet ?? 0) >= 2);
  hostClient.submit({ type: 'advance', toMinute: 1440 });
  await until(() => views.host?.state.minute === 1440);
  expect(views.host.days).toEqual([{ day: 0, team: 'team-1', pixels: 1 }]);
  await guestClient.poll();
  expect(views.guest.days).toEqual([{ day: 0, team: 'team-1', pixels: 1 }]);
  hostClient.stop(); guestClient.stop();
});
