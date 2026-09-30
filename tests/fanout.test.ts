import { afterEach, expect, test } from 'vitest';
import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createRoomService } from '../server/service';
import { createRoomServer } from '../server/http';
import { FASTLY_GRIP_PUBLIC_KEY, gripPublisher, gripVerifier, playerChannel, roomChannel } from '../server/grip';
import type { RoomEntry } from '../src/rooms/types';
import { acceptanceDataset } from './fixtures/room-roster';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const dataset = acceptanceDataset();
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
function jwt(claims: Record<string, unknown>, key: KeyObject = privateKey, alg = 'ES256') {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${part({ alg, typ: 'JWT' })}.${part(claims)}`;
  return `${body}.${sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
const future = () => Math.floor(Date.now() / 1000) + 60;

test('Grip-Sig verification accepts only unexpired ES256 tokens from the expected Fanout issuer', () => {
  const verify = gripVerifier({ publicKey, issuer: 'fastly:service-1' });
  expect(verify(jwt({ iss: 'fastly:service-1', exp: future() }))).toBe(true);
  expect(verify(jwt({ iss: 'fastly:other', exp: future() }))).toBe(false);
  expect(verify(jwt({ iss: 'fastly:service-1', exp: Math.floor(Date.now() / 1000) - 1 }))).toBe(false);
  expect(verify(jwt({ iss: 'fastly:service-1', exp: future() }, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey))).toBe(false);
  expect(verify(jwt({ iss: 'fastly:service-1', exp: future() }).replace(/^[^.]+/, Buffer.from('{"alg":"none"}').toString('base64url')))).toBe(false);
  for (const bad of [undefined, '', 'a.b', 'a.b.c', ['x']]) expect(verify(bad)).toBe(false);
  const local = gripVerifier({ secret: 'local-pushpin-secret', issuer: 'pushpin' });
  const hs = (claims: Record<string, unknown>, key: string) => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}`;
    return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
  };
  expect(local(hs({ iss: 'pushpin', exp: future() }, 'local-pushpin-secret'))).toBe(true);
  expect(local(hs({ iss: 'pushpin', exp: future() }, 'wrong-pushpin-secret'))).toBe(false);
  expect(local(jwt({ iss: 'pushpin', exp: future() }))).toBe(false);
  expect(verify(hs({ iss: 'fastly:service-1', exp: future() }, 'local-pushpin-secret'))).toBe(false);
  expect(() => gripVerifier({ secret: 'short' })).toThrow();
  // The embedded Fastly key parses, so the hosted default cannot fail at startup.
  expect(gripVerifier({ publicKey: FASTLY_GRIP_PUBLIC_KEY, issuer: 'fastly:x' })(jwt({ iss: 'fastly:x', exp: future() }))).toBe(false);
});

test('publisher sends committed events and revocation closes to GRIP channels without credentials in bodies', async () => {
  const sent: { url: string; headers: Headers; body: { items: Record<string, unknown>[] } }[] = [];
  const publisher = gripPublisher({ endpoint: 'https://api.fastly.com/service/SERVICE/publish/', token: 'fastly-token',
    request: (async (url: URL, init: RequestInit) => { sent.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body as string) }); return new Response('Published'); }) as typeof fetch });
  expect(() => gripPublisher({ endpoint: 'http://api.fastly.com/publish/' })).toThrow('HTTPS');
  const service = createRoomService({ dataset, databasePath: ':memory:', ...publisher }); cleanup.push(() => service.close());
  const host = service.create({ name: 'Fanout', hostId: dataset.players[0].id });
  service.command(host.session.code, host.session.token, { id: 'paint', command: { type: 'apply', tool: 'brush', x: 6, y: 0 } });
  await service.flushOutbox();
  expect(sent).toHaveLength(1);
  expect(sent[0].url).toBe('https://api.fastly.com/service/SERVICE/publish/');
  expect(sent[0].headers.get('fastly-key')).toBe('fastly-token');
  expect(sent[0].body.items).toEqual([{ channel: roomChannel(host.session.code), id: '2',
    formats: { 'http-stream': { content: 'id: 2\nevent: room\ndata: {"revision":2,"minute":0,"cells":[{"index":6,"owner":"team-0","shieldUntil":0}],"rosterChanged":false}\n\n' } } }]);
  service.logout(host.session.code, host.session.token);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(sent[1].body.items).toEqual([{ channel: playerChannel(dataset.players[0].id), formats: { 'http-stream': { action: 'close' } } }]);
  expect(playerChannel(dataset.players[0].id)).not.toContain('team-0');
  expect(JSON.stringify(sent.map(s => s.body))).not.toMatch(/fastly-token|balance|inventory/);
});

test('disabling an account closes that player\'s held streams', async () => {
  const closed: string[] = [];
  const service = createRoomService({ dataset, databasePath: ':memory:', accessMode: 'accounts', closeStreams: async player => { closed.push(player); } });
  cleanup.push(() => service.close());
  const auth = service.accounts!;
  const register = (index: number, organizer = false) => auth.register({ username: `player${index}`, password: 'Synthetic canvas password!', enrollment: auth.enroll(dataset.players[index].id, organizer).code }, 'test');
  const host = await register(0, true), member = await register(3);
  auth.disable(host.token, member.account.id);
  auth.logout(host.token);
  expect(closed).toEqual([dataset.players[3].id, dataset.players[0].id]);
}, 15000);

test('requests forwarded by Fanout get a GRIP hold with replay; direct requests keep the local stream', async () => {
  const service = createRoomService({ dataset, databasePath: ':memory:' });
  const server = createRoomServer({ service, distDir: '.', fanout: gripVerifier({ publicKey, issuer: 'fastly:service-1' }) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); service.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const host = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ name: 'Grip', hostId: dataset.players[0].id }) }).then(r => r.json()) as RoomEntry;
  const events = `${base}/api/rooms/${host.session.code}/events`;
  const auth = { authorization: `Bearer ${host.session.token}` };
  service.command(host.session.code, host.session.token, { id: 'paint', command: { type: 'apply', tool: 'brush', x: 1, y: 1 } });
  const held = await fetch(events, { headers: { ...auth, 'grip-sig': jwt({ iss: 'fastly:service-1', exp: future() }), 'last-event-id': '1' }, signal: AbortSignal.timeout(5000) });
  expect(held.headers.get('grip-hold')).toBe('stream');
  expect(held.headers.get('grip-channel')).toBe(`${roomChannel(host.session.code)}, ${playerChannel(dataset.players[0].id)}`);
  expect(held.headers.get('grip-keep-alive')).toContain('format=cstring');
  expect(await held.text()).toBe('retry: 3000\n\nid: 2\nevent: room\ndata: {"revision":2,"minute":0,"cells":[{"index":101,"owner":"team-0","shieldUntil":0}],"rosterChanged":false}\n\n');
  const forged = await fetch(events, { headers: { ...auth, 'grip-sig': jwt({ iss: 'fastly:service-1', exp: future() }, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey) } });
  expect(forged.headers.get('grip-hold')).toBeNull();
  expect(forged.headers.get('content-type')).toMatch(/^text\/event-stream/);
  await forged.body?.cancel();
  expect((await fetch(events, { headers: { 'grip-sig': jwt({ iss: 'fastly:service-1', exp: future() }) } })).status).toBe(401);
});
