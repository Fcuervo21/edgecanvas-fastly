import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRoomServer } from '../server/http';
import { createRoomService } from '../server/service';
import { COST } from '../src/game/rules';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'edge-http-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const dist = join(dir, 'dist'); mkdirSync(dist); writeFileSync(join(dist, 'index.html'), '<html>room lobby</html>');
  writeFileSync(join(dir, 'secret.txt'), 'private'); symlinkSync(join(dir, 'secret.txt'), join(dist, 'escape.txt'));
  const dataset = { dates: ['2026-07-01'], players: [
    { id: 'a', name: 'Alice', team: 'A', totalSteps: 5000, dailyGoal: 1, days: { '2026-07-01': 5000 } },
    { id: 'b', name: 'Bob', team: 'B', totalSteps: 6000, dailyGoal: 1, days: { '2026-07-01': 6000 } },
  ] };
  const service = createRoomService({ dataset, databasePath: ':memory:' }); cleanup.push(() => service.close());
  const server: Server = createRoomServer({ service, distDir: dist });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, token?: string) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { base, post, service, dir };
}
test('HTTP create and personal join converge under concurrent commands without revealing other histories', async () => {
  const { base, post } = await setup();
  const created = await post('/api/rooms', { name: 'Demo', hostId: 'a' }); expect(created.status).toBe(201);
  const host = await created.json(); const room = `/api/rooms/${host.session.code}`;
  const joined = await post(room + '/join', { inviteCode: host.invites.find((i: {playerId: string}) => i.playerId === 'b').code });
  expect(joined.status).toBe(200); const bob = await joined.json();
  expect(bob.view.dataset.players.map((p: {id: string}) => p.id)).toEqual(['b']);
  const [a, b] = await Promise.all([
    post(room + '/commands', { id: 'paint-a', command: { type: 'apply', tool: 'brush', x: 0, y: 0 } }, host.session.token),
    post(room + '/commands', { id: 'paint-b', command: { type: 'apply', tool: 'brush', x: 0, y: 0 } }, bob.session.token),
  ]);
  expect(a.status).toBe(200); expect(b.status).toBe(200);
  const ha = await fetch(base + room, { headers: { authorization: `Bearer ${host.session.token}` } }).then(r => r.json());
  const bb = await fetch(base + room, { headers: { authorization: `Bearer ${bob.session.token}` } }).then(r => r.json());
  expect(ha.state.cells).toEqual(bb.state.cells); expect(ha.state.spent + bb.state.spent).toBe(COST.brush + COST.rival);
  const unchanged = await fetch(base + room + `?after=${ha.revision}`, { headers: { authorization: `Bearer ${host.session.token}` } });
  expect(await unchanged.json()).toEqual({ unchanged: true });
  expect((await fetch(base + room + `?after=${ha.revision}`)).status).toBe(401);
  expect((await fetch(base + room + '/invites', { headers: { authorization: `Bearer ${bob.session.token}` } })).status).toBe(403);
});
test('HTTP rejects cross-site origins, hostile hosts, malformed commands and oversized JSON', async () => {
  const { base, post } = await setup();
  expect((await fetch(base + '/api/roster', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    get(base + '/api/roster', { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  expect(hostileHostStatus).toBe(403);
  const host = await (await post('/api/rooms', { name: 'Demo', hostId: 'a' })).json();
  const path = `/api/rooms/${host.session.code}/commands`;
  for (const command of [
    { type: 'buy', item: '__proto__' }, { type: 'advance', toMinute: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'apply', tool: 'brush', x: 0, y: 0, shape: 'evil' },
    { type: 'stroke', points: [{ x: 0, y: 0, balance: 10000 }] },
    { type: 'buy', item: 'bomb', playerId: 'b' },
  ]) expect((await post(path, { id: 'bad', command }, host.session.token)).status).toBe(400);
  expect((await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, authorization: `Bearer ${host.session.token}` }, body: '{' })).status).toBe(400);
  expect((await post('/api/rooms', { name: 'x'.repeat(300000), hostId: 'a' })).status).toBe(413);
  expect((await fetch(base + '/api/rooms', { method: 'POST', headers: { origin: base, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
});
test('serves production lobby but rejects traversal and symlinks outside dist', async () => {
  const { base } = await setup();
  const response = await fetch(base + '/?mode=rooms'); expect(response.status).toBe(200);
  expect(await response.text()).toContain('room lobby');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect((await fetch(base + '/escape.txt')).status).toBe(404);
  expect((await fetch(base + '/%2e%2e%2fsecret.txt')).status).toBe(404);
  expect((await fetch(base + '/.local/rooms.sqlite')).status).toBe(404);
});

test('HTTP logout is retry-safe and denies all subsequent session access', async () => {
  const { base, post } = await setup();
  const host = await (await post('/api/rooms', { name: 'Logout', hostId: 'a' })).json();
  const room = `/api/rooms/${host.session.code}`;
  const headers = { authorization: `Bearer ${host.session.token}` };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await post(room + '/logout', {}, host.session.token);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({ signedOut: true });
  }
  expect((await fetch(base + room + '?after=1', { headers })).status).toBe(401);
  expect((await fetch(base + room + '/invites', { headers })).status).toBe(401);
  expect((await post(room + '/commands', { id: 'after-logout', command: { type: 'buy', item: 'bomb' } }, host.session.token)).status).toBe(401);
});

test('logout requires a same-origin POST and cannot select another session in its body', async () => {
  const { base, post } = await setup();
  const host = await (await post('/api/rooms', { name: 'Logout boundary', hostId: 'a' })).json();
  const room = `/api/rooms/${host.session.code}`;
  const headers = { authorization: `Bearer ${host.session.token}` };
  expect((await fetch(base + room + '/logout', { headers })).status).toBe(404);
  expect((await post(room + '/logout', {})).status).toBe(401);
  expect((await post(room + '/logout', { token: 'another-session' }, host.session.token)).status).toBe(400);
  expect((await fetch(base + room + '/logout', {
    method: 'POST', headers: { ...headers, origin: 'https://outside.example', 'content-type': 'application/json' }, body: '{}',
  })).status).toBe(403);
  expect((await fetch(base + room, { headers })).status).toBe(200);
});
