import { RoomError } from '../rooms/errors';
import { newestVersion, type EdgeKV } from './kv';
import { sha256 } from './passwords';

/**
 * Records one attempt for `scope`; throws 429 once `limit` attempts happened in the current window.
 * `peek` only refuses a used-up scope without recording anything, so callers can count failures only.
 */
export interface Throttle {
  (scope: string, limit: number, windowSeconds: number): Promise<void>;
  peek(scope: string, limit: number, windowSeconds: number): Promise<void>;
}

const tooMany = () => new RoomError(429, 'Too many attempts. Please wait a few minutes and try again.');

/** IPv4 addresses stand alone; IPv6 addresses share a key per /64 so rotating suffixes gains nothing. */
export function clientKey(address: string): string {
  if (!address) return 'unknown';
  if (!address.includes(':') || address.includes('.')) return address.toLowerCase();
  const [head, tail] = address.toLowerCase().split('::');
  const before = head ? head.split(':') : [], after = tail ? tail.split(':') : [];
  const groups = tail === undefined ? before : [...before, ...Array(Math.max(0, 8 - before.length - after.length)).fill('0'), ...after];
  return `v6:${groups.slice(0, 4).map(g => (Number.parseInt(g || '0', 16) || 0).toString(16)).join(':')}`;
}

/**
 * Fixed-window limiter kept in KV, so it counts across every location (unlike Edge Rate Limiting,
 * whose counters are per POP and cannot be exercised in Viceroy). Each attempt claims the next
 * numbered slot of the window with an atomic insert-if-absent; once the slots are used up, further
 * attempts only read, so a flood cannot run up write costs. Slots expire on their own.
 */
export function createKvThrottle(kv: EdgeKV, now: () => number = Date.now): Throttle {
  const base = async (scope: string, windowSeconds: number) =>
    `t/${(await sha256(scope)).slice(0, 32)}/${Math.floor(now() / (windowSeconds * 1000))}/`;
  const throttle = (async (scope, limit, windowSeconds) => {
    const prefix = await base(scope, windowSeconds);
    // Losing a race just means the next slot; the bound also stops a stale-read loop from spinning.
    for (let attempt = 0; attempt < limit + 2; attempt++) {
      const taken = await newestVersion(kv, n => prefix + n);
      if (taken >= limit) break;
      if (await kv.add(prefix + (taken + 1), '1', { ttl: 2 * windowSeconds })) return;
    }
    throw tooMany();
  }) as Throttle;
  throttle.peek = async (scope, limit, windowSeconds) => {
    const prefix = await base(scope, windowSeconds);
    if ((await newestVersion(kv, n => prefix + n)) >= limit) throw tooMany();
  };
  return throttle;
}

/** A throttle that never refuses, for tests that are not about limits. */
export const noThrottle: Throttle = Object.assign(async () => {}, { peek: async () => {} });
