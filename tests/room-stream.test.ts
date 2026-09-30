import { afterEach, expect, test } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createRoomService } from '../server/service';
import { createRoomServer } from '../server/http';
import { connectRoom } from '../src/rooms/client';
import { readRoomStream, type StreamMessage } from '../src/rooms/events';
import type { RoomEntry, RoomView } from '../src/rooms/types';
import { acceptanceDataset } from './fixtures/room-roster';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const dataset = acceptanceDataset();

async function listen(accessMode: 'local' | 'accounts' = 'local') {
  const service = createRoomService({ dataset, databasePath: ':memory:', accessMode });
  const server = createRoomServer({ service, distDir: '.', heartbeatMs: 50 });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); service.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async <T>(path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
    expect(response.status).toBeLessThan(300);
    return await response.json() as T;
  };
  return { service, base, post };
}
/** Opens a stream and resolves `until` once `done(messages)` holds, with a bounded deadline. */
function open(url: string, headers: Record<string, string>) {
  const messages: StreamMessage[] = []; const controller = new AbortController();
  let check = () => {};
  const finished = readRoomStream(url, { headers, signal: controller.signal }, message => { messages.push(message); check(); }).catch(() => undefined);
  cleanup.push(() => controller.abort());
  const until = (done: (m: StreamMessage[]) => boolean) => new Promise<StreamMessage[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stream deadline')), 5000);
    check = () => { if (done(messages)) { clearTimeout(timer); resolve(messages); } }; check();
  });
  return { messages, until, finished, controller };
}

test('the local stream replays from Last-Event-ID, pushes committed changes and closes after logout', async () => {
  const { base, post } = await listen();
  const host = await post<RoomEntry>('/api/rooms', { name: 'Stream', hostId: dataset.players[0].id });
  const room = `/api/rooms/${host.session.code}`;
  const bob = await post<RoomEntry>(`${room}/join`, { inviteCode: host.invites!.find(i => i.playerId === dataset.players[3].id)!.code });
  const auth = (entry: RoomEntry) => ({ authorization: `Bearer ${entry.session.token}` });
  expect((await fetch(base + room + '/events')).status).toBe(401);
  const stream = open(base + room + '/events', { ...auth(bob), 'Last-Event-ID': '1' });
  await stream.until(m => m.length >= 1);
  expect(stream.messages[0]).toEqual({ type: 'room', event: { revision: 2, minute: 0, cells: [], rosterChanged: true } });
  await post(room + '/commands', { id: 'paint', command: { type: 'apply', tool: 'brush', x: 4, y: 0 } }, auth(host));
  await stream.until(m => m.length >= 2);
  expect(stream.messages[1]).toEqual({ type: 'room', event: { revision: 3, minute: 0, cells: [{ index: 4, owner: 'team-0', shieldUntil: 0 }], rosterChanged: false } });
  expect(JSON.stringify(stream.messages)).not.toMatch(/balance|inventory|token|days/);
  await post(room + '/logout', {}, auth(bob));
  await stream.until(m => m.some(message => message.type === 'denied'));
  await stream.finished;
  expect((await fetch(base + room + '/events', { headers: auth(bob) })).status).toBe(401);
});

test('the browser client applies pushed changes without one-second polling', async () => {
  const { base, post } = await listen();
  const host = await post<RoomEntry>('/api/rooms', { name: 'Live', hostId: dataset.players[0].id });
  const room = `/api/rooms/${host.session.code}`;
  const bob = await post<RoomEntry>(`${room}/join`, { inviteCode: host.invites!.find(i => i.playerId === dataset.players[3].id)!.code });
  let polls = 0; const seen: RoomView[] = []; let arrived = () => {};
  const request = ((url: string, init?: RequestInit) => {
    if (!url.includes('/events') && (init?.method ?? 'GET') === 'GET') polls++;
    return fetch(base + url, init);
  }) as typeof fetch;
  const client = connectRoom(bob.session, bob.view, { view: view => { seen.push(view); arrived(); }, status: () => {} }, request, { live: true });
  cleanup.push(() => client.stop());
  await new Promise(resolve => setTimeout(resolve, 2500));
  expect(polls).toBeLessThanOrEqual(1); // Only the catch-up check made when the stream opened.
  const received = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('no pushed view')), 5000); arrived = () => { clearTimeout(timer); resolve(); }; });
  await post(room + '/commands', { id: 'paint', command: { type: 'apply', tool: 'brush', x: 9, y: 9 } }, { authorization: `Bearer ${host.session.token}` });
  await received;
  expect(seen.at(-1)!.state.cells[909].owner).toBe('team-0');
  expect(seen.at(-1)!.state.playerId).toBe(dataset.players[3].id);
});

test('account streams require a member cookie and close when the account is disabled', async () => {
  const { service, base, post } = await listen('accounts');
  const auth = service.accounts!;
  const register = async (index: number, organizer = false) => {
    const response = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: `player${index}`, password: 'Synthetic canvas password!', enrollment: auth.enroll(dataset.players[index].id, organizer).code }) });
    const data = await response.json();
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrfToken as string, id: data.account.id as string };
  };
  const host = await register(0, true), member = await register(3);
  const hostHeaders = { cookie: host.cookie, 'x-csrf-token': host.csrf };
  const view = await post<RoomView>('/api/rooms', { name: 'Accounts' }, hostHeaders);
  const path = `${base}/api/rooms/${view.code}/events`;
  expect((await fetch(path)).status).toBe(401);
  const stream = open(path, { cookie: member.cookie, 'Last-Event-ID': '1' });
  await post(`/api/rooms/${view.code}/commands`, { id: 'paint', command: { type: 'apply', tool: 'brush', x: 2, y: 0 } }, hostHeaders);
  await stream.until(m => m.some(message => message.type === 'room' && message.event.revision === 2));
  auth.disable(host.cookie.split('=')[1], member.id);
  await stream.until(m => m.some(message => message.type === 'denied'));
}, 20000);
