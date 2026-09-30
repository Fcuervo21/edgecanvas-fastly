import { afterEach, expect, test, vi } from 'vitest';

// Rendering is tested in the browser. Exercise the real startup/storage boundary here.
vi.mock('../src/ui/game', () => ({
  mountGame: (_root: unknown, _data: unknown, state: unknown, save: (state: unknown) => boolean) => { save(state); },
}));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
test('a failed initial read cannot overwrite unknown progress even if writes work', async () => {
  let persisted = 'previous session that could not be read';
  vi.stubGlobal('window', { localStorage: {
    getItem() { throw new Error('temporary read failure'); },
    setItem(_key: string, value: string) { persisted = value; },
  } });
  vi.stubGlobal('document', { querySelector: () => ({}) });
  await import('../src/main');
  expect(persisted).toBe('previous session that could not be read');
});
