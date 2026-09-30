import { createHmac, generateKeyPairSync, pbkdf2Sync, sign } from 'node:crypto';
import { expect, test } from 'vitest';
import { createEdgeApp } from '../src/edge/app';
import { edgeGripVerifier, playerChannel } from '../src/edge/grip';
import { MemoryKV } from '../src/edge/kv';
import { hashPassword, verifyPassword } from '../src/edge/passwords';
import type { EdgeEvent, EdgeReply, EdgeView } from '../src/edge/types';
import { acceptanceDataset } from './fixtures/room-roster';
import { COST } from '../src/game/rules';

const ORIGIN = 'https://edge.example';
const ADMIN = 'admin-token-for-tests-'.padEnd(40, 'x');
const dataset = acceptanceDataset();
const [host, teammate, rival] = [dataset.players[0].id, dataset.players[1].id, dataset.players[3].id];
const password = 'correct horse battery staple 42';

function setup() {
  const kv = new MemoryKV(), events: EdgeEvent[] = [], closed: string[] = [];
  const app = createEdgeApp({ kv, adminToken: ADMIN, pepper: 'test-pepper', iterations: 3,
    publish: async (_room, event) => { events.push(event); }, closeStreams: async player => { closed.push(player); } });
  async function call(method: string, path: string, init: { body?: unknown; cookie?: string; csrf?: string; admin?: string; origin?: string | null; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...init.headers };
    if (init.origin !== null && method !== 'GET') headers.origin = init.origin ?? ORIGIN;
    if (init.cookie) headers.cookie = init.cookie;
    if (init.csrf) headers['x-csrf-token'] = init.csrf;
    if (init.admin) headers.authorization = `Bearer ${init.admin}`;
    const response = await app.handle(new Request(`${ORIGIN}${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), '198.51.100.7');
    const text = await response.text();
    return { response, status: response.status, data: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  }
  async function member(playerId: string, username: string, organizer = false) {
    const code = (await call('POST', '/api/admin/enroll', { admin: ADMIN, body: { playerId, organizer } })).data.code;
    const registered = await call('POST', '/api/auth/register', { body: { username, password, enrollment: code } });
    expect(registered.status).toBe(201);
    const cookie = registered.response.headers.get('set-cookie')!.split(';')[0];
    return { cookie, csrf: registered.data.csrfToken as string, account: registered.data.account };
  }
  return { app, kv, events, closed, call, member };
}

test('peppered PBKDF2 matches the standard construction and rejects wrong passwords', async () => {
  const record = await hashPassword(password, 'pepper', 50);
  const [, rounds, salt, hash] = record.split('$');
  const keyed = createHmac('sha256', 'pepper').update(password).digest();
  expect(pbkdf2Sync(keyed, Buffer.from(salt, 'hex'), Number(rounds), 32, 'sha256').toString('hex')).toBe(hash);
  expect(await verifyPassword(password, 'pepper', record)).toBe(true);
  expect(await verifyPassword(password, 'other pepper', record)).toBe(false);
  expect(await verifyPassword('wrong password entirely', 'pepper', record)).toBe(false);
  expect(await verifyPassword(password, 'pepper', undefined)).toBe(false);
});

test('each person signs in to their own profile and plays one shared room from KV', async () => {
  const { call, member, events } = setup();
  expect((await call('PUT', '/api/admin/dataset', { admin: 'wrong'.padEnd(40, 'x'), body: dataset })).status).toBe(401);
  expect((await call('PUT', '/api/admin/dataset', { admin: ADMIN, body: dataset })).data).toEqual({ players: dataset.players.length, dates: 2 });
  const fernando = await member(host, 'fernando', true), ana = await member(teammate, 'ana'), vero = await member(rival, 'veronica');
  // Registration codes are single-use and one account per roster place.
  const reuse = await call('POST', '/api/admin/enroll', { admin: ADMIN, body: { playerId: teammate } });
  expect(reuse.status).toBe(409);

  expect((await call('GET', '/api/account', { cookie: ana.cookie })).data.account).toMatchObject({ username: 'ana', playerId: teammate, organizer: false });
  expect((await call('POST', '/api/rooms', { cookie: ana.cookie, csrf: ana.csrf, body: { name: 'Nope' } })).status).toBe(403);
  const created = await call('POST', '/api/rooms', { cookie: fernando.cookie, csrf: fernando.csrf, body: { name: 'Splash' } });
  expect(created.status).toBe(201);
  const code = (created.data as EdgeView).code;
  expect((await call('GET', '/api/rooms', { cookie: vero.cookie })).data).toEqual([{ code, name: 'Splash' }]);

  // CSRF and same-origin checks guard every change.
  expect((await call('POST', `/api/rooms/${code}/join`, { cookie: vero.cookie, body: {} })).status).toBe(403);
  expect((await call('POST', `/api/rooms/${code}/join`, { cookie: vero.cookie, csrf: vero.csrf, body: {}, origin: 'https://evil.example' })).status).toBe(403);
  const joined = await call('POST', `/api/rooms/${code}/join`, { cookie: vero.cookie, csrf: vero.csrf, body: {} });
  expect(joined.status).toBe(200);
  expect((joined.data as EdgeView).dataset.players.map(p => p.id)).toEqual([rival]);

  const advance = await call('POST', `/api/rooms/${code}/commands`, { cookie: fernando.cookie, csrf: fernando.csrf, body: { id: 'day', command: { type: 'advance', toMinute: 1440 } } });
  expect((advance.data as EdgeReply).clock.minute).toBe(1440);
  const paint = (who: typeof ana, id: string) => call('POST', `/api/rooms/${code}/commands`, { cookie: who.cookie, csrf: who.csrf, body: { id, command: { type: 'apply', tool: 'brush', x: 3, y: 3 } } });
  expect(((await paint(ana, 'a')).data as EdgeReply).wallet.state.spent).toBe(COST.brush);
  const captured = (await paint(vero, 'v')).data as EdgeReply;
  expect(captured.code).toBe('OK'); expect(captured.wallet.state.spent).toBe(COST.rival);
  // Balances stay personal; the board is shared.
  const anaView = (await call('GET', `/api/rooms/${code}`, { cookie: ana.cookie })).data as EdgeView;
  expect(anaView.state.spent).toBe(COST.brush); expect(anaView.state.earned).toBe(40000);
  expect(anaView.state.cells[303].owner).toBe('team-1');
  expect(JSON.stringify(events)).not.toMatch(/spent|balance|inventory|days|fernando|ana/);

  // Without Fanout configured, the stream route answers with the GRIP hold on room and player channels.
  const stream = await call('GET', `/api/rooms/${code}/events`, { cookie: ana.cookie });
  expect(stream.response.headers.get('grip-hold')).toBe('stream');
  expect(stream.response.headers.get('grip-channel')).toBe(`room-${code}, ${await playerChannel(teammate)}`);
  expect((await call('GET', `/api/rooms/${code}/events`)).status).toBe(401);
});

test('logout, recovery and disabling revoke sessions and close live streams', async () => {
  const { call, member, closed } = setup();
  await call('PUT', '/api/admin/dataset', { admin: ADMIN, body: dataset });
  const fernando = await member(host, 'fernando', true), ana = await member(teammate, 'ana');
  const second = await call('POST', '/api/auth/login', { body: { username: 'ANA', password } });
  expect(second.status).toBe(200);
  expect((await call('POST', '/api/auth/login', { body: { username: 'ana', password: 'not the right password' } })).status).toBe(401);
  const secondCookie = second.response.headers.get('set-cookie')!.split(';')[0];

  expect((await call('POST', '/api/auth/logout', { cookie: ana.cookie, csrf: ana.csrf, body: {} })).data).toEqual({ signedOut: true });
  expect((await call('GET', '/api/account', { cookie: ana.cookie })).status).toBe(401);
  expect((await call('GET', '/api/account', { cookie: secondCookie })).status).toBe(200);
  expect(closed).toEqual([teammate]);

  const list = (await call('GET', '/api/admin/accounts', { cookie: fernando.cookie })).data as { id: string; username: string }[];
  const anaId = list.find(a => a.username === 'ana')!.id;
  const issued = await call('POST', `/api/admin/accounts/${anaId}/recovery`, { cookie: fernando.cookie, csrf: fernando.csrf, body: {} });
  const next = 'a brand new passphrase for ana';
  expect((await call('POST', '/api/auth/recover', { body: { code: issued.data.code, password: next } })).data).toEqual({ recovered: true });
  expect((await call('POST', '/api/auth/recover', { body: { code: issued.data.code, password: next } })).status).toBe(400);
  // A reset signs out every earlier session.
  expect((await call('GET', '/api/account', { cookie: secondCookie })).status).toBe(401);
  const relogin = await call('POST', '/api/auth/login', { body: { username: 'ana', password: next } });
  expect(relogin.status).toBe(200);

  expect((await call('POST', `/api/admin/accounts/${anaId}/disable`, { cookie: fernando.cookie, csrf: fernando.csrf, body: {} })).status).toBe(200);
  expect((await call('GET', '/api/account', { cookie: relogin.response.headers.get('set-cookie')!.split(';')[0] })).status).toBe(401);
  expect((await call('POST', '/api/auth/login', { body: { username: 'ana', password: next } })).status).toBe(401);
  const fernandoId = list.find(a => a.username === 'fernando')!.id;
  expect((await call('POST', `/api/admin/accounts/${fernandoId}/disable`, { cookie: fernando.cookie, csrf: fernando.csrf, body: {} })).status).toBe(400);
  expect(closed.filter(p => p === teammate).length).toBe(3);
});

test('only requests Fanout signed are held; others are handed to Fanout', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const verify = edgeGripVerifier({ jwk: publicKey.export({ format: 'jwk' }), issuer: 'fastly:svc' });
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = (claims: object, alg = 'ES256') => { const body = `${part({ alg, typ: 'JWT' })}.${part(claims)}`; return `${body}.${sign('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`; };
  const exp = Math.floor(Date.now() / 1000) + 60;
  expect(await verify(jwt({ iss: 'fastly:svc', exp }))).toBe(true);
  expect(await verify(jwt({ iss: 'fastly:other', exp }))).toBe(false);
  expect(await verify(jwt({ iss: 'fastly:svc', exp: exp - 120 }))).toBe(false);
  expect(await verify(jwt({ iss: 'fastly:svc', exp }, 'HS256'))).toBe(false);
  expect(await verify(null)).toBe(false);
  const hs = edgeGripVerifier({ secret: 'local-pushpin-secret' });
  const body = `${part({ alg: 'HS256' })}.${part({ exp })}`;
  expect(await hs(`${body}.${createHmac('sha256', 'local-pushpin-secret').update(body).digest('base64url')}`)).toBe(true);

  const handed: string[] = [];
  const app = createEdgeApp({ kv: new MemoryKV(), adminToken: ADMIN, pepper: 'p', iterations: 3,
    viaFanout: request => verify(request.headers.get('grip-sig')), handoff: request => { handed.push(request.url); return new Response('handed'); } });
  const cookie = `edgecanvas_account=${'a'.repeat(43)}`; // Streams need at least a well-formed session cookie to be handed off.
  const forged = await app.handle(new Request(`${ORIGIN}/api/rooms/ABCDEF123456/events`, { headers: { 'grip-sig': 'x.y.z', cookie } }));
  expect(await forged.text()).toBe('handed');
  const signed = await app.handle(new Request(`${ORIGIN}/api/rooms/ABCDEF123456/events`, { headers: { 'grip-sig': jwt({ iss: 'fastly:svc', exp }), cookie } }));
  expect(signed.status).toBe(401); // Forwarded by Fanout, then authorized like any other request.
  expect(handed).toHaveLength(1);
});

test('room views tell the browser whether live pushes are configured', async () => {
  async function liveFlag(extra: Parameters<typeof createEdgeApp>[0] extends infer O ? Partial<O> : never) {
    const app = createEdgeApp({ kv: new MemoryKV(), adminToken: ADMIN, pepper: 'p', iterations: 2, ...extra });
    const send = (path: string, init: RequestInit & { cookie?: string; csrf?: string } = {}) => app.handle(new Request(`${ORIGIN}${path}`,
      { ...init, headers: { origin: ORIGIN, ...(init.headers as Record<string, string>), ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.csrf ? { 'x-csrf-token': init.csrf } : {}) } }), '198.51.100.7');
    await send('/api/admin/dataset', { method: 'PUT', body: JSON.stringify(dataset), headers: { authorization: `Bearer ${ADMIN}` } } as RequestInit);
    const { code } = await (await send('/api/admin/enroll', { method: 'POST', body: JSON.stringify({ playerId: host, organizer: true }), headers: { authorization: `Bearer ${ADMIN}` } } as RequestInit)).json();
    const registered = await send('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'host', password, enrollment: code }) });
    const cookie = registered.headers.get('set-cookie')!.split(';')[0], { csrfToken } = await registered.json();
    const created = await (await send('/api/rooms', { method: 'POST', cookie, csrf: csrfToken, body: JSON.stringify({ name: 'Splash' }) })).json() as EdgeView & { live?: boolean };
    const again = await (await send(`/api/rooms/${created.code}`, { cookie })).json() as { live?: boolean };
    return [created.live, again.live];
  }
  expect(await liveFlag({})).toEqual([false, false]);
  expect(await liveFlag({ publish: async () => {} })).toEqual([true, true]);
  expect(await liveFlag({ publish: async () => {}, pushReady: async () => false })).toEqual([false, false]);
});

test('the host schedules automatic days over HTTP; others cannot, and the setting rides along in the room view', async () => {
  const { call, member } = setup();
  await call('PUT', '/api/admin/dataset', { admin: ADMIN, body: dataset });
  const fernando = await member(host, 'fernando', true), ana = await member(teammate, 'ana');
  const code = ((await call('POST', '/api/rooms', { cookie: fernando.cookie, csrf: fernando.csrf, body: { name: 'Splash' } })).data as EdgeView).code;
  await call('POST', `/api/rooms/${code}/join`, { cookie: ana.cookie, csrf: ana.csrf, body: {} });
  const path = `/api/rooms/${code}/schedule`;
  expect(((await call('GET', `/api/rooms/${code}`, { cookie: ana.cookie })).data as EdgeView).autoAdvance).toBeNull();
  expect((await call('POST', path, { cookie: fernando.cookie, body: { at: 600 } })).status).toBe(403);            // no CSRF token
  expect((await call('POST', path, { cookie: ana.cookie, csrf: ana.csrf, body: { at: 600 } })).status).toBe(403); // not the host
  expect((await call('POST', path, { cookie: fernando.cookie, csrf: fernando.csrf, body: { at: 'noon' } })).status).toBe(400);
  const set = await call('POST', path, { cookie: fernando.cookie, csrf: fernando.csrf, body: { at: 600 } });
  expect(set.status).toBe(200);
  expect((set.data as EdgeView).autoAdvance).toMatchObject({ at: 600 });
  expect(((await call('GET', `/api/rooms/${code}`, { cookie: ana.cookie })).data as EdgeView).autoAdvance).toMatchObject({ at: 600 });
  const off = await call('POST', path, { cookie: fernando.cookie, csrf: fernando.csrf, body: { at: null } });
  expect((off.data as EdgeView).autoAdvance).toBeNull();
});

test('the organizer tool starts a fresh room and retires the old ones, keeping accounts and step histories', async () => {
  const { call, member } = setup();
  await call('PUT', '/api/admin/dataset', { admin: ADMIN, body: dataset });
  const fernando = await member(host, 'fernando', true), ana = await member(teammate, 'ana');
  const first = ((await call('POST', '/api/rooms', { cookie: fernando.cookie, csrf: fernando.csrf, body: { name: 'Splash' } })).data as EdgeView).code;
  await call('POST', `/api/rooms/${first}/join`, { cookie: ana.cookie, csrf: ana.csrf, body: {} });
  await call('POST', `/api/rooms/${first}/commands`, { cookie: ana.cookie, csrf: ana.csrf, body: { id: 'a', command: { type: 'apply', tool: 'brush', x: 1, y: 1 } } });

  expect((await call('POST', '/api/admin/reset', { admin: 'wrong'.padEnd(40, 'x'), body: { hostId: host } })).status).toBe(401);
  expect((await call('POST', '/api/admin/reset', { admin: ADMIN, body: { hostId: 'nobody' } })).status).toBe(400);
  const reset = await call('POST', '/api/admin/reset', { admin: ADMIN, body: { name: 'Splash', hostId: host } });
  expect(reset.status).toBe(201);
  expect(reset.data.code).not.toBe(first);
  // Everyone signs in with the same account and finds only the new, empty room.
  const rooms = (await call('GET', '/api/rooms', { cookie: ana.cookie })).data as { code: string; name: string }[];
  expect(rooms).toEqual([{ code: reset.data.code, name: 'Splash' }]);
  await call('POST', `/api/rooms/${reset.data.code}/join`, { cookie: ana.cookie, csrf: ana.csrf, body: {} });
  const view = (await call('GET', `/api/rooms/${reset.data.code}`, { cookie: ana.cookie })).data as EdgeView;
  expect(view.state.spent).toBe(0); expect(view.state.minute).toBe(0);
  expect(view.state.cells.every(cell => cell.owner === null)).toBe(true);
  expect(view.isHost).toBe(false);
  expect(((await call('GET', `/api/rooms/${reset.data.code}`, { cookie: fernando.cookie })).data as EdgeView).isHost).toBe(true);
});
