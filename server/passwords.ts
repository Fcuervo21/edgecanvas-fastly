import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { RoomError } from './errors';
import { blockedPasswordHashes } from './data/password-blocklist';
const blockedPasswords = new Set<string>(blockedPasswordHashes);

// OWASP scrypt baseline. Keep this local adapter out of the future Compute bundle.
const options = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
let active = 0;
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (active >= 2) throw new RoomError(429, 'Sign-in is busy. Please try again shortly.');
  active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, options,
      (error, result) => error ? reject(error) : resolve(result)));
  } finally { active--; }
}
export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || [...value].length < 15 || [...value].length > 128 || Buffer.byteLength(value) > 512) {
    throw new RoomError(400, 'Use a password between 15 and 128 characters.');
  }
  if (blockedPasswords.has(createHash('sha256').update(value.toLowerCase(), 'utf8').digest('hex'))) {
    throw new RoomError(400, 'Choose a different password. This one appears in a commonly used or compromised password list.');
  }
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16), result = await derive(password, salt);
  return `scrypt$131072$8$1$${salt.toString('hex')}$${result.toString('hex')}`;
}
export async function verifyPassword(password: string, record?: string): Promise<boolean> {
  const match = /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(record ?? '');
  // Unknown/disabled users still pay the same password-verification cost.
  const actual = await derive(password, match ? Buffer.from(match[1], 'hex') : Buffer.alloc(16));
  return timingSafeEqual(actual, match ? Buffer.from(match[2], 'hex') : Buffer.alloc(64)) && !!match;
}
