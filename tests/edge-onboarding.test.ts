import { expect, test } from 'vitest';
import { createEdgeApp } from '../src/edge/app';
import { MemoryKV } from '../src/edge/kv';
import { suggestUsername } from '../src/ui/username';
import { acceptanceDataset } from './fixtures/room-roster';

const ORIGIN = 'https://edge.example', ADMIN = 'admin-token-for-tests-'.padEnd(43, 'x'), CLOCK = 1_800_000_000_000;
const dataset = acceptanceDataset(), [ana, bruno] = [dataset.players[1], dataset.players[3]];

function setup() {
  const kv = new MemoryKV(); kv.now = () => CLOCK;
  const app = createEdgeApp({ kv, adminToken: ADMIN, pepper: 'test-pepper', iterations: 3, now: () => CLOCK });
  async function call(method: string, path: string, body?: unknown, admin = false) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (method !== 'GET') headers.origin = ORIGIN;
    if (admin) headers.authorization = `Bearer ${ADMIN}`;
    const response = await app.handle(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), '198.51.100.7');
    const text = await response.text(); let data: any = text; try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, data };
  }
  const ready = () => call('PUT', '/api/admin/dataset', dataset, true);
  return { call, ready };
}

test('a registration code can be looked up to greet its owner without using it up', async () => {
  const { call, ready } = setup();
  await ready();
  const code = (await call('POST', '/api/admin/enroll', { playerId: ana.id }, true)).data.code;
  const peek = await call('POST', '/api/auth/enrollment', { code });
  expect(peek.status).toBe(200);
  expect(peek.data).toEqual({ name: ana.name, team: ana.team });
  // Still usable afterwards, and once used it no longer greets anyone.
  const registered = await call('POST', '/api/auth/register', { username: 'ana', password: 'correct horse battery staple 42', enrollment: code });
  expect(registered.status).toBe(201);
  expect((await call('POST', '/api/auth/enrollment', { code })).status).toBe(400);
});

test('unknown, malformed and used codes all get the same refusal', async () => {
  const { call, ready } = setup();
  await ready();
  const refusals = await Promise.all(['x'.repeat(43), 'short', 'A'.repeat(43)].map(code => call('POST', '/api/auth/enrollment', { code })));
  expect(refusals.map(r => r.status)).toEqual([400, 400, 400]);
  expect(new Set(refusals.map(r => r.data.error)).size).toBe(1);
  expect((await call('POST', '/api/auth/enrollment', {})).status).toBe(400);
});

test('an organizer can issue codes that last up to seven days, and no longer', async () => {
  const { call, ready } = setup();
  await ready();
  const week = await call('POST', '/api/admin/enroll', { playerId: ana.id, days: 7 }, true);
  expect(week.status).toBe(201);
  expect(week.data.expiresAt - CLOCK).toBe(7 * 24 * 60 * 60 * 1000);
  expect((await call('POST', '/api/admin/enroll', { playerId: bruno.id, days: 8 }, true)).status).toBe(400);
  expect((await call('POST', '/api/admin/enroll', { playerId: bruno.id, days: 0 }, true)).status).toBe(400);
  expect((await call('POST', '/api/admin/enroll', { playerId: bruno.id }, true)).data.expiresAt - CLOCK).toBe(24 * 60 * 60 * 1000);
});

test('usernames are suggested from the roster name', () => {
  expect(suggestUsername('Marta Núñez Ortega')).toBe('marta.nunez');
  expect(suggestUsername('Diego Serrano')).toBe('diego.serrano');
  expect(suggestUsername('Kai Tanaka')).toBe('kai.tanaka');
  expect(suggestUsername('Omar Abdel-Karim')).toBe('omar.abdel-karim');
  expect(suggestUsername('Cher')).toBe('cher');
  expect(suggestUsername('Ó')).toMatch(/^[a-z0-9][a-z0-9._-]{2,31}$/);
  expect(suggestUsername('A very long given name indeed with many words')).toMatch(/^[a-z0-9][a-z0-9._-]{2,31}$/);
});
