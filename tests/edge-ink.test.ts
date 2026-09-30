import { expect, test, vi } from 'vitest';
import { createEdgeApp } from '../src/edge/app';
import { createEdgeAuthority } from '../src/edge/authority';
import { MemoryKV, type EdgeKV } from '../src/edge/kv';
import type { EdgeEvent, EdgeView } from '../src/edge/types';
import { connectEdgeRoom } from '../src/rooms/edge-client';
import { acceptanceDataset } from './fixtures/room-roster';

const dataset = acceptanceDataset();
const [host, rival] = [dataset.players[0].id, dataset.players[3].id];

// Ink: a live preview of what a player is drawing, published to the room at once, before the slow save catches up.
test('ink goes straight to the room without touching storage, and only for real cells', async () => {
  const inner = new MemoryKV(); let touched = 0;
  const kv: EdgeKV = { get: k => { touched++; return inner.get(k); }, put: (k, v) => { touched++; return inner.put(k, v); }, delete: k => inner.delete(k), list: p => inner.list(p),
    add: (k, v, o) => { touched++; return inner.add(k, v, o); } };
  const events: EdgeEvent[] = [];
  const authority = createEdgeAuthority({ kv, publish: async (_room, event) => { events.push(event); } });
  const { code } = await authority.createRoom({ name: 'Edge', hostId: host, dataset }, { invites: false });
  events.length = 0; const before = touched;
  const from = { player: rival, team: 'team-1' };
  await authority.ink(code, from, { cells: [5, 5, 6, 9999] });
  expect(events).toEqual([{ type: 'ink', from: rival, team: 'team-1', cells: [5, 6, 9999] }]);       // repeats are dropped
  expect(touched).toBe(before);                                                                    // no lookups, no writes
  for (const cells of [[-1], [10000], [1.5], ['7'], Array.from({ length: 401 }, (_, i) => i), 'nope', undefined]) await expect(authority.ink(code, from, { cells } as never)).rejects.toMatchObject({ status: 400 });
  expect(events).toHaveLength(1);
});

async function hosted(now: () => number = Date.now, random: () => number = () => 0) {
  const kv = new MemoryKV(), events: EdgeEvent[] = [];
  const app = createEdgeApp({ kv, adminToken: 'a'.repeat(40), pepper: 'p', iterations: 2, now, random, publish: async (_r, e) => { events.push(e); } });
  const send = (path: string, init: RequestInit & { cookie?: string } = {}) => app.handle(new Request(`https://edge.example${path}`,
    { ...init, headers: { origin: 'https://edge.example', ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string>) } }), '198.51.100.9');
  await send('/api/admin/dataset', { method: 'PUT', headers: { authorization: `Bearer ${'a'.repeat(40)}` }, body: JSON.stringify(dataset) });
  const person = async (playerId: string, username: string, organizer = false) => {
    const { code } = await (await send('/api/admin/enroll', { method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(40)}` }, body: JSON.stringify({ playerId, organizer }) })).json();
    const response = await send('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password: 'a long enough passphrase 123', enrollment: code }) });
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: (await response.json()).csrfToken as string };
  };
  const fernando = await person(host, 'fernando', true), vero = await person(rival, 'vero');
  const { code } = await (await send('/api/rooms', { method: 'POST', cookie: fernando.cookie, headers: { 'x-csrf-token': fernando.csrf }, body: JSON.stringify({ name: 'Splash' }) })).json();
  await send(`/api/rooms/${code}/join`, { method: 'POST', cookie: vero.cookie, headers: { 'x-csrf-token': vero.csrf }, body: '{}' });
  const ticketOf = async (who: typeof vero) => ((await (await send(`/api/rooms/${code}`, { cookie: who.cookie })).json()) as EdgeView).ink!;
  const ink = (cells: unknown, ticket: string | null, room = code) => send(`/api/rooms/${room}/ink`, { method: 'POST', headers: ticket ? { 'x-ink-ticket': ticket } : {}, body: JSON.stringify({ cells }) });
  return { events, code, fernando, vero, ticketOf, ink, send };
}

test('a room view carries a ticket that alone is enough to preview: no session, no lookups of the account', async () => {
  const { events, vero, ticketOf, ink } = await hosted();
  const ticket = await ticketOf(vero);
  expect(ticket).toBeTruthy();
  expect((await ink([1, 2], ticket)).status).toBe(200);
  expect(events.filter(e => e.type === 'ink')).toEqual([{ type: 'ink', from: rival, team: 'team-1', cells: [1, 2] }]);
  expect((await ink(['x'], ticket)).status).toBe(400);
});

test('tickets cannot be forged, reused for another room, or used after they expire', async () => {
  let at = 1_000_000_000_000;
  const { code, vero, ticketOf, ink } = await hosted(() => at);
  const ticket = await ticketOf(vero);
  expect((await ink([1], null)).status).toBe(403);
  expect((await ink([1], ticket.slice(0, -2) + 'AA')).status).toBe(403);
  expect((await ink([1], ticket, 'ABCDEF123456')).status).toBe(403);
  expect(code).not.toBe('ABCDEF123456');
  at += 3 * 3600 * 1000;
  expect((await ink([1], ticket)).status).toBe(403);      // never 401: the browser would think its session ended
});

test("a player's previews are capped; the excess is refused before anything is published", async () => {
  const at = Date.now();
  // Only one request in four is recorded, so with every request drawn as recorded the cap is a quarter of the ~200 allowed.
  const { events, vero, ticketOf, ink } = await hosted(() => at, () => 0);
  const ticket = await ticketOf(vero);
  let accepted = 0, status = 200;
  for (let i = 0; i < 260 && status === 200; i++) { status = (await ink([i], ticket)).status; if (status === 200) accepted++; }
  expect(status).toBe(429);
  expect(accepted).toBe(50);
  expect(events.filter(e => e.type === 'ink')).toHaveLength(50);
});

test('unrecorded requests cost no storage writes, so drawing does not load the store', async () => {
  const kv = new MemoryKV();
  const app = createEdgeApp({ kv, adminToken: 'a'.repeat(40), pepper: 'p', iterations: 2, random: () => 0.99, publish: async () => {} });
  const { issueInkTicket } = await import('../src/edge/ink-ticket');
  const ticket = await issueInkTicket('p', { room: 'ABCDEF123456', player: rival, team: 'team-1', exp: Date.now() + 60000 });
  const before = kv.writes;
  for (let i = 0; i < 30; i++) expect((await app.handle(new Request('https://edge.example/api/rooms/ABCDEF123456/ink', { method: 'POST', headers: { origin: 'https://edge.example', 'x-ink-ticket': ticket }, body: JSON.stringify({ cells: [i] }) }), '198.51.100.9')).status).toBe(200);
  expect(kv.writes).toBe(before);
});

// The client side: what the painter sends and what everyone else shows.
async function live() {
  const app = createEdgeApp({ kv: new MemoryKV(), adminToken: 'a'.repeat(40), pepper: 'p', iterations: 2, publish: async () => {} });
  const send = (path: string, init: RequestInit & { cookie?: string } = {}) => app.handle(new Request(`https://edge.example${path}`,
    { ...init, headers: { origin: 'https://edge.example', ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string>) } }));
  await send('/api/admin/dataset', { method: 'PUT', headers: { authorization: `Bearer ${'a'.repeat(40)}` }, body: JSON.stringify(dataset) });
  async function person(playerId: string, username: string, organizer = false) {
    const { code } = await (await send('/api/admin/enroll', { method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(40)}` }, body: JSON.stringify({ playerId, organizer }) })).json();
    const response = await send('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password: 'a long enough passphrase 123', enrollment: code }) });
    const cookie = response.headers.get('set-cookie')!.split(';')[0], { csrfToken } = await response.json();
    const calls: string[] = [];
    let stream!: ReadableStreamDefaultController<string>;
    const events = new ReadableStream<string>({ start(controller) { stream = controller; } });
    let gate: Promise<void> = Promise.resolve(), inkGate: Promise<void> = Promise.resolve();
    const inks: number[][] = []; let inFlight = 0, peak = 0;
    const browser = (async (url: string | URL | Request, init: RequestInit = {}) => {
      const path = String(url); calls.push(path);
      if (path.endsWith('/events')) return new Response(events.pipeThrough(new TextEncoderStream()), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      if (path.endsWith('/commands')) await gate;
      if (path.endsWith('/ink')) {
        inks.push(JSON.parse(String(init.body)).cells); peak = Math.max(peak, ++inFlight);
        try {
          // Like a real fetch, give up when the caller aborts.
          await Promise.race([inkGate, new Promise<never>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))]);
          return await send(path, { ...init, cookie });
        } finally { inFlight--; }
      }
      return send(path, { ...init, cookie });
    }) as typeof fetch;
    return { cookie, csrfToken, browser, calls, inks, peak: () => peak,
      holdInk: () => { let release!: () => void; inkGate = new Promise<void>(resolve => { release = resolve; }); return release; }, push: (event: EdgeEvent) => stream.enqueue(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
      holdCommands: () => { let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; }); return release; } };
  }
  const a = await person(host, 'host', true), b = await person(rival, 'rival');
  const view = await (await send('/api/rooms', { method: 'POST', cookie: a.cookie, headers: { 'x-csrf-token': a.csrfToken }, body: JSON.stringify({ name: 'Splash' }) })).json() as EdgeView;
  await send(`/api/rooms/${view.code}/join`, { method: 'POST', cookie: b.cookie, headers: { 'x-csrf-token': b.csrfToken }, body: '{}' });
  const open = async (who: typeof a) => (await who.browser(`/api/rooms/${view.code}`)).json() as Promise<EdgeView>;
  return { a, b, code: view.code, open };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await new Promise(r => setTimeout(r, 10)); expect(check()).toBe(true); };

test('a stroke is previewed to the room straight away, while the save is still in flight', async () => {
  const { b, code, open } = await live();
  const release = b.holdCommands();
  const client = connectEdgeRoom({ code, csrfToken: b.csrfToken }, await open(b), { view: () => {}, status: () => {} }, b.browser, { live: true });
  client.submit({ type: 'stroke', points: [{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 12, y: 10 }] });
  await until(() => b.calls.some(u => u.endsWith('/ink')));
  expect(b.calls.filter(u => u.endsWith('/commands'))).toHaveLength(1);   // the save has been asked for but not answered
  release(); client.stop();
});

test("someone else's pixels appear the moment the preview arrives, and your own preview echoing back is ignored", async () => {
  const { a, code, open } = await live();
  const shown: EdgeView[] = []; const changes: number[][] = [];
  const client = connectEdgeRoom({ code, csrfToken: a.csrfToken }, await open(a), { view: (v, changed) => { shown.push(v as EdgeView); changes.push(changed ?? []); }, status: () => {} }, a.browser, { live: true });
  await until(() => a.calls.some(u => u.endsWith('/events')));
  a.push({ type: 'ink', from: rival, team: 'team-1', cells: [1010, 1011, 1012] });
  await until(() => shown.at(-1)?.state.cells[1010].owner === 'team-1');
  expect(changes).toContainEqual([1010, 1011, 1012]);                 // announced as new arrivals, so the canvas can reveal them
  expect(shown.at(-1)!.state.spent).toBe(0);                          // a preview never touches anyone's paint
  // Your own preview echoing back is ignored.
  a.push({ type: 'ink', from: host, team: 'team-0', cells: [2000] });
  a.push({ type: 'ink', from: rival, team: 'team-1', cells: [3000] });
  await until(() => shown.at(-1)?.state.cells[3000].owner === 'team-1');
  expect(shown.at(-1)!.state.cells[2000].owner).toBeNull();
  client.stop();
});

test('an unsaved preview fades out on its own, a saved one stays, and a preview never covers a shield', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { a, code, open } = await live();
    const initial = await open(a);
    initial.state.cells[500] = { owner: 'team-1', shieldUntil: 99999 };       // a rival shield
    initial.state.cells[501] = { owner: 'team-0', shieldUntil: 0 };
    let latest!: EdgeView;
    const client = connectEdgeRoom({ code, csrfToken: a.csrfToken }, initial, { view: v => { latest = v as EdgeView; }, status: () => {} }, a.browser, { live: true });
    await vi.advanceTimersByTimeAsync(50);
    a.push({ type: 'ink', from: rival, team: 'team-2', cells: [500, 501, 502] });
    await vi.advanceTimersByTimeAsync(50);
    expect(latest.state.cells[500].owner).toBe('team-1');                     // shielded: untouched
    expect(latest.state.cells[502].owner).toBe('team-2');
    // Pixel 800 is previewed and then really saved by its tile; 502 is never saved.
    a.push({ type: 'ink', from: rival, team: 'team-2', cells: [800] });
    await vi.advanceTimersByTimeAsync(50);
    expect(latest.state.cells[800].owner).toBe('team-2');
    const tile = Array.from({ length: 100 }, (_, i) => [i === 80 ? 'team-2' : null, 0] as [string | null, number]);
    a.push({ type: 'tile', tile: 0, version: 1, cells: tile } as EdgeEvent);
    await vi.advanceTimersByTimeAsync(11000);
    expect(latest.state.cells[502].owner).toBeNull();                         // never saved: gone
    expect(latest.state.cells[800].owner).toBe('team-2');                     // saved: stays
    client.stop();
  } finally { vi.useRealTimers(); }
});

test('previews leave one request at a time, so they reach the room in the order they were drawn', async () => {
  const { b, code, open } = await live();
  const release = b.holdInk();
  const client = connectEdgeRoom({ code, csrfToken: b.csrfToken }, await open(b), { view: () => {}, status: () => {} }, b.browser, { live: true });
  const stroke = (from: number, length: number) => ({ type: 'stroke' as const, points: Array.from({ length }, (_, i) => ({ x: from + i, y: 10 })) });
  client.submit(stroke(10, 1));
  await until(() => b.inks.length === 1);
  client.submit(stroke(11, 2)); client.submit(stroke(13, 2)); client.submit(stroke(15, 1));
  await new Promise(r => setTimeout(r, 300));
  expect(b.inks).toEqual([[1010]]);                      // the rest waits behind the first: none can overtake it
  release();
  await until(() => b.inks.length === 2);
  expect(b.inks[1]).toEqual([1011, 1012, 1013, 1014, 1015]);
  expect(b.peak()).toBe(1);
  client.stop();
});

test('a preview request that hangs does not hold back the next ones for long', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { b, code, open } = await live();
    b.holdInk();                                          // never released
    const client = connectEdgeRoom({ code, csrfToken: b.csrfToken }, await open(b), { view: () => {}, status: () => {} }, b.browser, { live: true });
    client.submit({ type: 'stroke', points: [{ x: 10, y: 10 }] });
    await vi.advanceTimersByTimeAsync(200);
    client.submit({ type: 'stroke', points: [{ x: 11, y: 10 }] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(b.inks).toEqual([[1010], [1011]]);
    client.stop();
  } finally { vi.useRealTimers(); }
});
