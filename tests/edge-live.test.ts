import { expect, test } from 'vitest';
import { createEdgeApp, type EdgeAppOptions } from '../src/edge/app';
import { MemoryKV } from '../src/edge/kv';

const ORIGIN = 'https://edge.example', ADMIN = 'admin-token-for-tests-'.padEnd(43, 'x');
function setup(extra: Partial<EdgeAppOptions> = {}) {
  const app = createEdgeApp({ kv: new MemoryKV(), adminToken: ADMIN, pepper: 'test-pepper', iterations: 3, ...extra });
  const call = (method: string, path: string, admin: string | null = ADMIN) => app.handle(new Request(`${ORIGIN}${path}`,
    { method, headers: { ...(method !== 'GET' ? { origin: ORIGIN } : {}), ...(admin ? { authorization: `Bearer ${admin}` } : {}) } }), '198.51.100.7');
  return { call };
}

test('the live-check stream is for the organizer only', async () => {
  const handed: string[] = [];
  const { call } = setup({ viaFanout: async () => false, handoff: request => { handed.push(request.url); return new Response('handed'); } });
  expect((await call('GET', '/api/admin/events', null)).status).toBe(401);
  expect((await call('GET', '/api/admin/events', 'wrong-token'.padEnd(43, 'x'))).status).toBe(401);
  expect(handed).toHaveLength(0);
  expect(await (await call('GET', '/api/admin/events')).text()).toBe('handed');
  expect(handed).toHaveLength(1);
});

test('once Fanout forwards it, the live-check stream is held on its own channel', async () => {
  const { call } = setup({ viaFanout: async () => true, handoff: () => new Response('handed') });
  const response = await call('GET', '/api/admin/events');
  expect(response.status).toBe(200);
  expect(response.headers.get('grip-hold')).toBe('stream');
  expect(response.headers.get('grip-channel')).toBe('admin-health');
  expect(response.headers.get('content-type')).toContain('text/event-stream');
});

test('a ping is published to the live-check channel and reports why it could not be', async () => {
  const sent: number[] = [];
  const working = setup({ publishHealth: async at => { sent.push(at); } });
  const ok = await working.call('POST', '/api/admin/ping');
  expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ published: true });
  expect(sent).toHaveLength(1);
  const failing = setup({ publishHealth: async () => { throw new Error('GRIP publish failed with HTTP 401'); } });
  const bad = await failing.call('POST', '/api/admin/ping');
  expect(bad.status).toBe(502); expect(await bad.json()).toEqual({ published: false, error: 'GRIP publish failed with HTTP 401' });
  const unset = await setup().call('POST', '/api/admin/ping');
  expect(unset.status).toBe(409);
  expect((await working.call('POST', '/api/admin/ping', null)).status).toBe(401);
});
