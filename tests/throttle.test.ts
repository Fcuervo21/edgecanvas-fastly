import { expect, test } from 'vitest';
import { MemoryKV } from '../src/edge/kv';
import { clientKey, createKvThrottle } from '../src/edge/throttle';

function setup() {
  let now = 1_000_000;
  const kv = new MemoryKV();
  kv.now = () => now;
  return { kv, throttle: createKvThrottle(kv, () => now), advance: (ms: number) => { now += ms; } };
}
const status = async (attempt: Promise<void>) => attempt.then(() => 200, (error: { status?: number }) => error.status);

test('allows exactly the limit inside a window, then refuses with 429', async () => {
  const { throttle } = setup();
  const results: (number | undefined)[] = [];
  for (let i = 0; i < 7; i++) results.push(await status(throttle('login:ana', 5, 900)));
  expect(results).toEqual([200, 200, 200, 200, 200, 429, 429]);
});

test('a new window starts fresh', async () => {
  const { throttle, advance } = setup();
  for (let i = 0; i < 5; i++) await throttle('login:ana', 5, 60);
  expect(await status(throttle('login:ana', 5, 60))).toBe(429);
  advance(61_000);
  expect(await status(throttle('login:ana', 5, 60))).toBe(200);
});

test('scopes are independent', async () => {
  const { throttle } = setup();
  for (let i = 0; i < 5; i++) await throttle('login:ana', 5, 900);
  expect(await status(throttle('login:ana', 5, 900))).toBe(429);
  expect(await status(throttle('login:bruno', 5, 900))).toBe(200);
});

test('a refused attempt writes nothing, so a flood cannot run up write costs', async () => {
  const { kv, throttle } = setup();
  for (let i = 0; i < 5; i++) await throttle('address:198.51.100.7', 5, 900);
  const before = kv.writes;
  for (let i = 0; i < 50; i++) expect(await status(throttle('address:198.51.100.7', 5, 900))).toBe(429);
  expect(kv.writes).toBe(before);
});

test('a parallel burst can never exceed the limit', async () => {
  const { throttle } = setup();
  const results = await Promise.all(Array.from({ length: 40 }, () => status(throttle('burst', 8, 60))));
  expect(results.filter(code => code === 200)).toHaveLength(8);
  expect(results.filter(code => code === 429)).toHaveLength(32);
});

test('window records expire on their own so the store does not grow', async () => {
  const { kv, throttle, advance } = setup();
  await throttle('login:ana', 5, 900);
  expect(await kv.list('t')).toHaveLength(1);
  advance(2 * 900 * 1000 + 1000);
  expect(await kv.list('t')).toHaveLength(0);
});

test('peek refuses a scope that is used up without consuming an attempt', async () => {
  const { kv, throttle } = setup();
  for (let i = 0; i < 4; i++) await throttle('fail:ana', 5, 900);
  const before = kv.writes;
  for (let i = 0; i < 10; i++) expect(await status(throttle.peek('fail:ana', 5, 900))).toBe(200);
  expect(kv.writes).toBe(before);
  await throttle('fail:ana', 5, 900);
  expect(await status(throttle.peek('fail:ana', 5, 900))).toBe(429);
});

test('IPv6 clients are limited per /64 network and IPv4 per address', () => {
  expect(clientKey('198.51.100.7')).toBe('198.51.100.7');
  expect(clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(clientKey('2001:db8:1:2:1111:2222:3333:4444'));
  expect(clientKey('2001:db8:1:2::1')).not.toBe(clientKey('2001:db8:1:3::1'));
  expect(clientKey('2001:DB8:1:2::1')).toBe(clientKey('2001:db8:1:2:0:0:0:9'));
  expect(clientKey('')).toBe('unknown');
});
