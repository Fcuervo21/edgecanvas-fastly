import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { createEdgeApp, type EdgeAppOptions } from '../src/edge/app';
import { MemoryKV } from '../src/edge/kv';
import type { EdgeView } from '../src/edge/types';
import { acceptanceDataset } from './fixtures/room-roster';

const ORIGIN = 'https://edge.example';
const ADMIN = 'admin-token-for-tests-'.padEnd(43, 'x');
const PASSWORD = 'correct horse battery staple 42';
const dataset = acceptanceDataset();
const [host, second] = [dataset.players[0].id, dataset.players[1].id];
/** A fixed clock keeps every rate-limit window stable for the whole test. */
const CLOCK = 1_800_000_000_000;

interface Init { body?: unknown; raw?: string; cookie?: string; csrf?: string; admin?: string; ip?: string; url?: string; headers?: Record<string, string> }
function setup(extra: Partial<EdgeAppOptions> = {}) {
  const kv = new MemoryKV();
  kv.now = () => CLOCK;
  const app = createEdgeApp({ kv, adminToken: ADMIN, pepper: 'test-pepper', iterations: 3, now: () => CLOCK, ...extra });
  let visitor = 0;
  async function call(method: string, path: string, init: Init = {}) {
    const headers: Record<string, string> = { ...init.headers };
    if (method !== 'GET') headers.origin = ORIGIN;
    if (init.cookie) headers.cookie = init.cookie;
    if (init.csrf) headers['x-csrf-token'] = init.csrf;
    if (init.admin) headers.authorization = `Bearer ${init.admin}`;
    const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
    const response = await app.handle(new Request(init.url ?? `${ORIGIN}${path}`, { method, headers, body }), init.ip ?? '198.51.100.7');
    const text = await response.text();
    let data: any = text; try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { response, status: response.status, data };
  }
  async function ready() { await call('PUT', '/api/admin/dataset', { admin: ADMIN, body: dataset, ip: '203.0.113.250' }); }
  async function member(playerId: string, username: string, organizer = false) {
    const ip = `192.0.2.${++visitor}`;
    const code = (await call('POST', '/api/admin/enroll', { admin: ADMIN, body: { playerId, organizer }, ip })).data.code;
    const registered = await call('POST', '/api/auth/register', { body: { username, password: PASSWORD, enrollment: code }, ip });
    expect(registered.status).toBe(201);
    return { cookie: registered.response.headers.get('set-cookie')!.split(';')[0], csrf: registered.data.csrfToken as string };
  }
  return { kv, app, call, ready, member };
}
const wrong = (i: number) => `not the right password number ${i} xx`;

test('failed logins lock out the guesser, never the account owner on another network', async () => {
  const { call, ready, member } = setup();
  await ready(); await member(second, 'victim');
  for (let i = 0; i < 5; i++) expect((await call('POST', '/api/auth/login', { ip: '203.0.113.9', body: { username: 'victim', password: wrong(i) } })).status).toBe(401);
  expect((await call('POST', '/api/auth/login', { ip: '203.0.113.9', body: { username: 'victim', password: wrong(6) } })).status).toBe(429);
  expect((await call('POST', '/api/auth/login', { ip: '198.51.100.20', body: { username: 'victim', password: PASSWORD } })).status).toBe(200);
});

test('successful sign-ins do not use up the failed-attempt budget', async () => {
  const { call, ready, member } = setup();
  await ready(); await member(second, 'victim');
  for (let i = 0; i < 12; i++) expect((await call('POST', '/api/auth/login', { ip: '198.51.100.20', body: { username: 'victim', password: PASSWORD } })).status).toBe(200);
});

test('guessing one account from many networks trips an account-wide cap', async () => {
  const { call, ready, member } = setup();
  await ready(); await member(second, 'victim');
  for (let i = 0; i < 50; i++) await call('POST', '/api/auth/login', { ip: `203.0.113.${i + 1}`, body: { username: 'victim', password: wrong(i) } });
  expect((await call('POST', '/api/auth/login', { ip: '198.51.100.99', body: { username: 'victim', password: PASSWORD } })).status).toBe(429);
});

test('one network cannot spray many usernames past the address cap, yet a shared office network has room to sign in', async () => {
  const { call, ready } = setup();
  await ready();
  const codes: number[] = [];
  for (let i = 0; i < 122; i++) codes.push((await call('POST', '/api/auth/login', { ip: '203.0.113.9', body: { username: `spray-${i}`, password: wrong(i) } })).status);
  expect(codes.slice(0, 120).every(code => code === 401)).toBe(true);
  expect(codes.slice(120)).toEqual([429, 429]);
});

test('a junk recovery code costs a constant amount of KV work, not a scan of every account', async () => {
  const { kv, call, ready, member } = setup();
  await ready(); await member(host, 'organizer', true); await member(second, 'someone');
  const lists = kv.lists, reads = kv.reads;
  const response = await call('POST', '/api/auth/recover', { ip: '203.0.113.9', body: { code: 'A'.repeat(43), password: 'a perfectly fine passphrase 123' } });
  expect(response.status).toBe(400);
  expect(kv.lists).toBe(lists);
  expect(kv.reads - reads).toBeLessThanOrEqual(4);
});

test('a forged logout does no writes and one read', async () => {
  const { kv, call, ready } = setup();
  await ready();
  const forged = 'f'.repeat(43), csrf = createHash('sha256').update(`edgecanvas-csrf:${forged}`).digest('hex');
  const writes = kv.writes, reads = kv.reads;
  const response = await call('POST', '/api/auth/logout', { cookie: `edgecanvas_account=${forged}`, csrf, body: {}, ip: '203.0.113.9' });
  expect(response.status).toBe(200);
  expect(kv.writes).toBe(writes);
  expect(kv.reads - reads).toBeLessThanOrEqual(1);
});

test('a flood of made-up session cookies is cut off per network', async () => {
  const { call, ready } = setup();
  await ready();
  const codes: number[] = [];
  for (let i = 0; i < 42; i++) codes.push((await call('GET', '/api/account', { ip: '203.0.113.9', cookie: `edgecanvas_account=${String(i).padStart(43, 'q')}` })).status);
  expect(codes.slice(0, 40).every(code => code === 401)).toBe(true);
  expect(codes.slice(40)).toEqual([429, 429]);
  // Visitors who simply are not signed in (no cookie) are never counted.
  for (let i = 0; i < 30; i++) expect((await call('GET', '/api/account', { ip: '203.0.113.77' })).status).toBe(401);
});

test('stream requests without a well-formed session cookie never reach Fanout', async () => {
  const handed: string[] = [];
  const { call } = setup({ viaFanout: async () => false, handoff: request => { handed.push(request.url); return new Response('handed'); } });
  const anonymous = await call('GET', '/api/rooms/ABCDEF123456/events');
  expect(anonymous.status).toBe(401);
  expect(handed).toHaveLength(0);
  const shaped = await call('GET', '/api/rooms/ABCDEF123456/events', { cookie: `edgecanvas_account=${'a'.repeat(43)}` });
  expect(shaped.data).toBe('handed');
  expect(handed).toHaveLength(1);
});

test('each player is limited to 40 commands per 10 seconds', async () => {
  const { call, ready, member } = setup();
  await ready();
  const organizer = await member(host, 'organizer', true), other = await member(second, 'other');
  const room = (await call('POST', '/api/rooms', { cookie: organizer.cookie, csrf: organizer.csrf, body: { name: 'Splash' } })).data as EdgeView;
  await call('POST', `/api/rooms/${room.code}/join`, { cookie: other.cookie, csrf: other.csrf, body: {} });
  const codes: number[] = [];
  for (let i = 0; i < 42; i++) codes.push((await call('POST', `/api/rooms/${room.code}/commands`, { cookie: other.cookie, csrf: other.csrf,
    body: { id: `cmd-${i}`, command: { type: 'apply', tool: 'brush', x: 0, y: 0 } } })).status);
  expect(codes.slice(0, 40).every(code => code === 200)).toBe(true);
  expect(codes.slice(40)).toEqual([429, 429]);
  // The host's own budget is separate.
  expect((await call('POST', `/api/rooms/${room.code}/commands`, { cookie: organizer.cookie, csrf: organizer.csrf, body: { id: 'host-1', command: { type: 'advance', toMinute: 1440 } } })).status).toBe(200);
});

test('an organizer can create at most five rooms per hour', async () => {
  const { call, ready, member } = setup();
  await ready();
  const organizer = await member(host, 'organizer', true);
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await call('POST', '/api/rooms', { cookie: organizer.cookie, csrf: organizer.csrf, body: { name: `Room ${i}` } })).status);
  expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
});

test('client-supplied version hints cannot force slow reads', async () => {
  const { call, ready, member } = setup();
  await ready();
  const organizer = await member(host, 'organizer', true);
  const room = (await call('POST', '/api/rooms', { cookie: organizer.cookie, csrf: organizer.csrf, body: { name: 'Splash' } })).data as EdgeView;
  const started = Date.now();
  const response = await call('POST', `/api/rooms/${room.code}/commands`, { cookie: organizer.cookie, csrf: organizer.csrf,
    headers: { 'x-wallet-version': '9007199254740991', 'x-clock-version': '9007199254740991' },
    body: { id: 'hinted', command: { type: 'advance', toMinute: 1440 } } });
  expect(response.status).toBe(200);
  expect(Date.now() - started).toBeLessThan(1000);
});

test('a JSON null body is a 400, and an oversized declared body is refused before it is read', async () => {
  const { call, ready, member } = setup();
  await ready();
  const organizer = await member(host, 'organizer', true);
  expect((await call('POST', '/api/rooms', { cookie: organizer.cookie, csrf: organizer.csrf, raw: 'null' })).status).toBe(400);
  expect((await call('POST', '/api/admin/enroll', { admin: ADMIN, raw: 'null' })).status).toBe(400);
  const big = await call('POST', '/api/auth/login', { raw: '{}', headers: { 'content-length': '5000000', 'content-type': 'application/json' }, ip: '203.0.113.9' });
  expect(big.status).toBe(413);
});

test('wrong organizer tokens are throttled per network', async () => {
  const { call } = setup();
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) codes.push((await call('POST', '/api/admin/enroll', { admin: `wrong-token-${i}`.padEnd(43, 'x'), body: { playerId: host }, ip: '203.0.113.9' })).status);
  expect(codes.slice(0, 10).every(code => code === 401)).toBe(true);
  expect(codes.slice(10)).toEqual([429, 429]);
});

test('hosted mode refuses plain HTTP instead of serving cookies or passwords over it', async () => {
  const { call } = setup({ requireHttps: true });
  const page = await call('GET', '/', { url: 'http://edge.example/' });
  expect(page.status).toBe(301);
  expect(page.response.headers.get('location')).toBe('https://edge.example/');
  const login = await call('POST', '/api/auth/login', { url: 'http://edge.example/api/auth/login', body: { username: 'a', password: 'b' } });
  expect(login.status).toBe(400);
  expect((await call('GET', '/api/account')).status).toBe(401);
});

test('session records expire on their own after the session does', async () => {
  const { kv, ready, member } = setup();
  await ready(); await member(host, 'organizer', true);
  const sessions = async () => (await kv.list('a')).filter(key => key.startsWith('a/s/'));
  expect(await sessions()).toHaveLength(1);
  kv.now = () => CLOCK + 10 * 60 * 60 * 1000;
  expect(await sessions()).toHaveLength(0);
});

test('secrets are only read by the routes that need them', async () => {
  const reads = { admin: 0, pepper: 0 };
  const { call } = setup({
    adminToken: async () => { reads.admin++; return ADMIN; },
    pepper: async () => { reads.pepper++; return 'test-pepper'; },
  });
  // Pages and session checks never touch the Secret Store: that keeps them fast and cheap.
  await call('GET', '/');
  await call('GET', '/api/account');
  await call('GET', '/api/account', { cookie: `edgecanvas_account=${'q'.repeat(43)}` });
  expect(reads).toEqual({ admin: 0, pepper: 0 });
  // The organizer token is read for organizer tooling, the pepper only when a password is hashed.
  await call('PUT', '/api/admin/dataset', { admin: ADMIN, body: dataset });
  expect(reads).toEqual({ admin: 1, pepper: 0 });
  const code = (await call('POST', '/api/admin/enroll', { admin: ADMIN, body: { playerId: host } })).data.code;
  await call('POST', '/api/auth/register', { body: { username: 'someone', password: PASSWORD, enrollment: code }, ip: '192.0.2.1' });
  expect(reads.pepper).toBe(1);
  expect((await call('POST', '/api/auth/login', { body: { username: 'someone', password: 'wrong password entirely 12345' }, ip: '192.0.2.1' })).status).toBe(401);
  expect(reads.pepper).toBe(1);
});
