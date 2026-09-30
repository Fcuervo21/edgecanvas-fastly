import { afterEach, expect, test, vi } from 'vitest';
import { signOut } from '../src/ui/accounts';
afterEach(() => vi.unstubAllGlobals());
test.each(['offline', 'server', 'invalid'])('account logout retains retry on %s and navigates only after acknowledgment', async failure => {
  let retry: () => void = () => {};
  const root = { innerHTML: '', querySelector: () => ({ addEventListener: (_type: string, callback: () => void) => { retry = callback; } }) };
  const fetch = vi.fn().mockImplementationOnce(() => failure === 'offline' ? Promise.reject(new Error('offline')) : Promise.resolve(new Response(JSON.stringify(failure === 'server' ? { error: 'server' } : {}), { status: failure === 'server' ? 500 : 200, headers: { 'Content-Type': 'application/json' } })))
    .mockResolvedValue(new Response(JSON.stringify({ signedOut: true }), { headers: { 'Content-Type': 'application/json' } }));
  const replace = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubGlobal('location', { replace });
  await signOut(root as unknown as HTMLElement, 'csrf');
  expect(replace).not.toHaveBeenCalled(); expect(root.innerHTML).toContain('retry-signout');
  retry(); await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
  expect(fetch.mock.calls[1][1]).toMatchObject({ credentials: 'same-origin', headers: { 'X-CSRF-Token': 'csrf' } });
});
