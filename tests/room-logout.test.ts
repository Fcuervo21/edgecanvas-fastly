import { afterEach, expect, test, vi } from 'vitest';
import { mountRooms } from '../src/ui/rooms';

const key = 'edgecanvas.room-session.v1';
const saved = JSON.stringify({ code: 'ABCDEF123456', token: 'synthetic-session' });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
afterEach(() => vi.unstubAllGlobals());
function setup(logout: () => Promise<Response>) {
  const storage = new Map([[key, saved]]);
  const navigate = vi.fn();
  const requests: string[] = [];
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    requests.push(path);
    if (path.endsWith('/logout')) {
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-session' });
      return logout();
    }
    return response({ error: 'Roster unavailable for this test.' }, 503);
  });
  vi.stubGlobal('fetch', request);
  const location = { search: '?mode=rooms&leave=1', replace: navigate };
  vi.stubGlobal('location', location);
  vi.stubGlobal('sessionStorage', {
    getItem: (name: string) => storage.get(name) ?? null,
    removeItem: (name: string) => storage.delete(name),
  });
  const listeners = new Map<string, () => void>();
  const root = { innerHTML: '', querySelector: () => ({
    addEventListener: (event: string, handler: () => void) => listeners.set(event, handler),
  }) } as unknown as HTMLElement;
  return { root, storage, navigate, requests, listeners };
}

test('leaving retains the token until server acknowledgment, then clears it and consumes the URL flag', async () => {
  let acknowledge!: (response: Response) => void;
  const s = setup(() => new Promise(resolve => { acknowledge = resolve; }));
  const leaving = mountRooms(s.root);
  expect(s.storage.get(key)).toBe(saved);
  expect(s.navigate).not.toHaveBeenCalled();
  acknowledge(response({ signedOut: true }));
  await leaving;
  expect(s.storage.has(key)).toBe(false);
  expect(s.navigate).toHaveBeenCalledWith('?mode=rooms');
  expect(s.requests).toEqual(['/api/rooms/ABCDEF123456/logout']);
});

test.each(['offline', 'server-error', 'invalid-ack'])('failed logout (%s) preserves a retry without opening the lobby', async failure => {
  const s = setup(async () => {
    if (failure === 'offline') throw new TypeError('Connection lost');
    return failure === 'server-error' ? response({ error: 'Unavailable' }, 503) : response({});
  });
  await mountRooms(s.root);
  expect(s.storage.get(key)).toBe(saved);
  expect(s.navigate).not.toHaveBeenCalled();
  expect(s.requests).toEqual(['/api/rooms/ABCDEF123456/logout']);
  expect(s.root.innerHTML).toContain('Try leaving again');
});

test('a lost logout acknowledgment can be retried from the recovery button', async () => {
  let attempts = 0;
  const s = setup(async () => {
    if (++attempts === 1) throw new TypeError('Acknowledgment lost after server revocation');
    return response({ signedOut: true });
  });
  await mountRooms(s.root);
  s.listeners.get('click')!();
  await vi.waitFor(() => expect(s.storage.has(key)).toBe(false));
  expect(attempts).toBe(2);
  expect(s.navigate).toHaveBeenCalledWith('?mode=rooms');
});

test('a leave URL with no saved session opens the lobby without a logout request', async () => {
  const s = setup(async () => { throw new Error('No session to revoke'); });
  s.storage.clear();
  await mountRooms(s.root);
  expect(s.requests).toEqual([]);
  expect(s.navigate).toHaveBeenCalledWith('?mode=rooms');
});
