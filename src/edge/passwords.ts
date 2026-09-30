import { blockedPasswordHashes } from '../../server/data/password-blocklist';
import { RoomError } from '../rooms/errors';

/**
 * Password hashing that runs on Fastly Compute, whose WebCrypto offers HMAC but not PBKDF2 or
 * scrypt. PBKDF2-HMAC-SHA256 is computed with one native HMAC per iteration (about 30 µs each in
 * Viceroy), so the iteration count stays far below the OWASP figure for unpeppered hashes. Two
 * things compensate: every password is first keyed with a secret pepper that lives in the Secret
 * Store, never next to the hashes in KV, and passwords must be 15+ characters and not on the
 * breached-password list. A copy of the KV data alone therefore cannot be brute-forced.
 */
export const PBKDF2_ITERATIONS = 10_000;
const blocked = new Set<string>(blockedPasswordHashes);
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = (text: string) => new Uint8Array(text.match(/../g)!.map(b => parseInt(b, 16)));
export async function sha256(text: string) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text))); }

export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || [...value].length < 15 || [...value].length > 128 || encoder.encode(value).length > 512) {
    throw new RoomError(400, 'Use a password between 15 and 128 characters.');
  }
}
/** Same screening as the local server: SHA-256 of the lowercased password against the pinned list. */
export async function screenPassword(value: string) {
  if (blocked.has(await sha256(value.toLowerCase()))) {
    throw new RoomError(400, 'Choose a different password. This one appears in a commonly used or compromised password list.');
  }
}

async function hmac(key: BufferSource, data: BufferSource) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
async function derive(password: string, pepper: string, salt: Uint8Array, iterations: number) {
  const keyed = await hmac(encoder.encode(pepper), encoder.encode(password));
  const key = await crypto.subtle.importKey('raw', keyed, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  // PBKDF2 block 1: U1 = HMAC(P, salt || INT(1)); T = U1 ^ U2 ^ … ^ Uc.
  let u = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array([...salt, 0, 0, 0, 1])));
  const t = u.slice();
  for (let i = 1; i < iterations; i++) {
    u = new Uint8Array(await crypto.subtle.sign('HMAC', key, u));
    for (let j = 0; j < t.length; j++) t[j] ^= u[j];
  }
  return t;
}
export async function hashPassword(password: string, pepper: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-peppered$${iterations}$${hex(salt)}$${hex(await derive(password, pepper, salt, iterations))}`;
}
/** Unknown users still pay the same cost, so timing does not reveal which usernames exist. */
export async function verifyPassword(password: string, pepper: string, record?: string, iterations = PBKDF2_ITERATIONS): Promise<boolean> {
  const match = /^pbkdf2-peppered\$(\d+)\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(record ?? '');
  const rounds = match ? Number(match[1]) : iterations;
  const actual = await derive(password, pepper, match ? unhex(match[2]) : new Uint8Array(16), rounds);
  const expected = match ? unhex(match[3]) : new Uint8Array(32);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= actual[i] ^ expected[i];
  return diff === 0 && !!match;
}
