import { afterEach, expect, test, vi } from 'vitest';
import { mountAccounts } from '../src/ui/accounts';
afterEach(() => { vi.unstubAllGlobals(); });
test.each(['', '?mode=rooms', '?mode=solo'])('hosted startup requires login for query %s without reading local saves', async search => {
  const root = { innerHTML: '', querySelector: () => ({ addEventListener: vi.fn() }), querySelectorAll: () => [] };
  const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ error: 'Sign in to continue.' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
  const getItem = vi.fn(), setItem = vi.fn();
  vi.stubGlobal('location', { search }); vi.stubGlobal('sessionStorage', { getItem, setItem }); vi.stubGlobal('localStorage', { getItem, setItem }); vi.stubGlobal('fetch', request);
  await mountAccounts(root as unknown as HTMLElement);
  expect(root.innerHTML).toContain('Sign in'); expect(root.innerHTML).toContain('Registration code');
  expect(root.innerHTML).not.toContain('hostId'); expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe('/api/account'); expect(getItem).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled();
});
test('an unavailable account server never falls back to the local game', async () => {
  const root = { innerHTML: '' };
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  await mountAccounts(root as HTMLElement);
  expect(root.innerHTML).toContain('Sign-in is unavailable'); expect(root.innerHTML).not.toContain('<canvas');
});

test('the welcome page explaining the challenge is reachable while signed in', async () => {
  const root = { innerHTML: '', querySelector: () => ({ addEventListener: vi.fn() }), querySelectorAll: () => [] };
  const request = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify({ account: { username: 'fernando', organizer: true }, csrfToken: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('location', { search: '?welcome' }); vi.stubGlobal('fetch', request);
  await mountAccounts(root as unknown as HTMLElement);
  expect(root.innerHTML).toContain('Get in with three steps'); expect(root.innerHTML).toContain('Paint. Defend. Repeat.');
  expect(root.innerHTML).toContain('Go to my rooms'); expect(root.innerHTML).toContain('fernando');
  // Only the account check: no rooms are loaded for the welcome page.
  expect(request).toHaveBeenCalledTimes(1);
});

test('a member with a single room goes straight into it instead of the lobby', async () => {
  const root = { innerHTML: '', querySelector: () => ({ addEventListener: vi.fn(), textContent: '' }), querySelectorAll: () => [] };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const request = vi.fn(async (url: RequestInfo | URL) => String(url) === '/api/account' ? json({ account: { username: 'ana', organizer: false }, csrfToken: 'x' })
    : String(url) === '/api/rooms' ? json([{ code: 'ABCDEF123456', name: 'Splash' }]) : json({ code: 'ABCDEF123456' }));
  vi.stubGlobal('location', { search: '' }); vi.stubGlobal('fetch', request);
  await mountAccounts(root as unknown as HTMLElement);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(request.mock.calls.map(call => String(call[0]))).toContain('/api/rooms/ABCDEF123456/join');
});

test('an organizer still lands in the lobby to manage rooms and accounts', async () => {
  const root = { innerHTML: '', querySelector: () => ({ addEventListener: vi.fn(), textContent: '' }), querySelectorAll: () => [] };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const request = vi.fn(async (url: RequestInfo | URL) => String(url) === '/api/account' ? json({ account: { username: 'fernando', organizer: true }, csrfToken: 'x' }) : json([{ code: 'ABCDEF123456', name: 'Splash' }]));
  vi.stubGlobal('location', { search: '' }); vi.stubGlobal('fetch', request);
  await mountAccounts(root as unknown as HTMLElement);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(request.mock.calls.map(call => String(call[0]))).not.toContain('/api/rooms/ABCDEF123456/join');
  expect(root.innerHTML).toContain('Welcome, fernando');
});
