import { RoomError } from '../rooms/errors';
import { newestVersion, type EdgeKV } from './kv';
import { hashPassword, screenPassword, sha256, validatePassword, verifyPassword } from './passwords';
import { noThrottle, type Throttle } from './throttle';

export interface Account { id: string; username: string; playerId: string; organizer: boolean }
interface AccountRecord extends Account {
  passwordHash: string; disabled: boolean;
  /** Bumped by recovery and disabling; sessions from an older epoch stop working. */
  epoch: number;
  recovery: { hash: string; issuer: string; expiresAt: number } | null;
}
interface SessionRecord { account: string; epoch: number; expiresAt: number }
interface EnrollmentRecord { player: string; organizer: boolean; expiresAt: number }

export const ACCOUNT_SESSION_MS = 8 * 60 * 60 * 1000;
/** Every credential attempt from one network: 120 per 15 minutes (a whole roster may sit behind one office address). */
const ADDRESS_LIMIT = 120, WINDOW = 900;
/** Failed sign-ins: 5 per account per network, and 50 per account overall, per 15 minutes. */
const FAILS_PER_NETWORK = 5, FAILS_PER_ACCOUNT = 50;
const fail = (status: number, message: string): never => { throw new RoomError(status, message); };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(() => resolve(), ms));
function secret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) return fail(400, 'Invalid account request.');
  return value as Record<string, unknown>;
}
function username(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(value)) return fail(400, 'Use a username of 3–32 letters, numbers, dots, underscores or hyphens.');
  return value.toLowerCase();
}
export const csrfToken = (token: string) => sha256(`edgecanvas-csrf:${token}`);
export async function validCsrf(token: string, supplied: unknown) {
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expected = await csrfToken(token);
  let diff = 0; for (let i = 0; i < 64; i++) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return diff === 0;
}

/**
 * Invite-only username/password accounts stored in KV, with the same rules as the local account
 * mode (docs/accounts.md). Account records are write-once versions (`a/id/<id>/<n>`), so a
 * password reset and a disable cannot silently overwrite each other; uniqueness of usernames,
 * roster places and one-time codes relies on KV insert-if-absent.
 */
export function createEdgeAccounts(options: { kv: EdgeKV; pepper: () => Promise<string>; playerIds: () => Promise<string[]>;
  playerInfo?: (playerId: string) => Promise<{ name: string; team: string } | null>;
  throttle?: Throttle; now?: () => number; iterations?: number; onRevoke?: (playerId: string) => Promise<void> }) {
  const { kv } = options; const pepper = () => options.pepper(); const now = options.now ?? Date.now;
  const throttle = options.throttle ?? noThrottle;
  const key = {
    account: (id: string, n: number) => `a/id/${id}/${n}`,
    // Listable key families avoid "/" and ":", which the real KV Store refuses in listing prefixes.
    username: (name: string) => `usr-${name}`,
    player: (player: string) => `a/p/${encodeURIComponent(player)}`,
    session: (hash: string) => `a/s/${hash}`,
    enrollment: (hash: string) => `a/e/${hash}`,
    enrollmentUsed: (hash: string) => `a/eu/${hash}`,
    enrollmentLatest: (player: string) => `a/el/${encodeURIComponent(player)}`,
    /** Recovery code hash -> account id, so redeeming a code never scans the accounts. */
    recovery: (hash: string) => `a/rc/${hash}`,
  };
  const json = async <T>(k: string): Promise<T | null> => { const text = await kv.get(k); return text === null ? null : JSON.parse(text) as T; };
  /** Reads a key that should exist, tolerating an eventually consistent miss. */
  async function settled<T>(k: string, tries = 4): Promise<T | null> {
    for (let i = 0; i < tries; i++) { const value = await json<T>(k); if (value !== null) return value; if (i < tries - 1) await wait(25 * 2 ** i); }
    return null;
  }
  async function readAccount(id: string): Promise<{ version: number; record: AccountRecord } | null> {
    const version = await newestVersion(kv, n => key.account(id, n));
    if (!version) return null;
    const record = await settled<AccountRecord>(key.account(id, version));
    return record && { version, record };
  }
  async function roster(player: string) { return (await options.playerIds()).includes(player); }
  const publicAccount = (r: AccountRecord): Account => ({ id: r.id, username: r.username, playerId: r.playerId, organizer: r.organizer });
  async function session(record: AccountRecord) {
    const token = secret(), expiresAt = now() + ACCOUNT_SESSION_MS;
    // The record outlives the session by an hour, then the store drops it, so sessions never pile up.
    await kv.add(key.session(await sha256(token)), JSON.stringify({ account: record.id, epoch: record.epoch, expiresAt } satisfies SessionRecord), { ttl: ACCOUNT_SESSION_MS / 1000 + 3600 });
    return { account: publicAccount(record), token, expiresAt, csrfToken: await csrfToken(token) };
  }
  async function current(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return fail(401, 'Sign in to continue.');
    // A session created moments ago may not be visible at this location yet.
    const s = await settled<SessionRecord>(key.session(await sha256(token)), 3);
    if (!s || s.expiresAt <= now()) return fail(401, 'Sign in to continue.');
    const account = await readAccount(s.account);
    if (!account || account.record.disabled || account.record.epoch !== s.epoch || !(await roster(account.record.playerId))) return fail(401, 'Sign in to continue.');
    return { account: publicAccount(account.record), expiresAt: s.expiresAt, csrfToken: await csrfToken(token) };
  }
  async function requireOrganizer(token: string) {
    const result = await current(token);
    if (!result.account.organizer) return fail(403, 'Only an organizer can do that.');
    return result;
  }
  /** Writes the next version of an account; returns false if another change won the race. */
  const writeAccount = (version: number, record: AccountRecord) => kv.add(key.account(record.id, version + 1), JSON.stringify(record));
  async function enrollment(code: unknown) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return fail(400, 'Unable to register with these details.');
    const hash = await sha256(code);
    const row = await json<EnrollmentRecord>(key.enrollment(hash));
    const valid = row && row.expiresAt > now() && await kv.get(key.enrollmentLatest(row.player)) === hash
      && await kv.get(key.enrollmentUsed(hash)) === null && await roster(row.player);
    if (!valid) return fail(400, 'Unable to register with these details.');
    return { hash, row: row! };
  }
  async function accountByName(name: string) {
    const id = await kv.get(key.username(name));
    return id ? readAccount(id) : null;
  }
  async function revoke(record: AccountRecord) { await options.onRevoke?.(record.playerId).catch(() => {}); }

  return {
    current, requireOrganizer,
    /** Organizer tooling behind the admin secret: a one-time registration code for a roster place. */
    async enroll(playerId: string, organizer = false, lifetimeMs = 24 * 60 * 60000) {
      if (typeof playerId !== 'string' || !(await roster(playerId)) || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 7 * 24 * 60 * 60000) return fail(400, 'Invalid enrollment settings.');
      if (await kv.get(key.player(playerId))) return fail(409, 'That participant already has an account.');
      const code = secret(), hash = await sha256(code), expiresAt = now() + lifetimeMs;
      await kv.add(key.enrollment(hash), JSON.stringify({ player: playerId, organizer: !!organizer, expiresAt } satisfies EnrollmentRecord));
      // Reissuing replaces the latest code, which revokes earlier unused ones.
      await kv.put(key.enrollmentLatest(playerId), hash);
      return { code, expiresAt, playerId };
    },
    async register(input: unknown, client: string) {
      await throttle(`address:${client}`, ADDRESS_LIMIT, WINDOW);
      const data = fields(input, ['username', 'password', 'enrollment']);
      const name = username(data.username); validatePassword(data.password); await screenPassword(data.password);
      const { hash, row } = await enrollment(data.enrollment);
      const passwordHash = await hashPassword(data.password, await pepper(), options.iterations);
      // Each claim is an atomic insert: the code once, the roster place once, the username once.
      if (!(await kv.add(key.enrollmentUsed(hash), '1'))) return fail(400, 'Unable to register with these details.');
      const id = crypto.randomUUID();
      if (!(await kv.add(key.player(row.player), id))) return fail(400, 'Unable to register with these details.');
      if (!(await kv.add(key.username(name), id))) {
        await kv.delete(key.player(row.player));
        return fail(400, 'Unable to register with these details.');
      }
      const record: AccountRecord = { id, username: name, playerId: row.player, organizer: row.organizer, passwordHash, disabled: false, epoch: 0, recovery: null };
      await writeAccount(0, record);
      return session(record);
    },
    /** Greets the owner of a valid, unused code by name, so a personal link can say "Welcome, Ana". Uses nothing up. */
    async describeEnrollment(input: unknown, client: string) {
      await throttle(`address:${client}`, ADDRESS_LIMIT, WINDOW);
      const data = fields(input, ['code']);
      const { row } = await enrollment(data.code);
      const info = await options.playerInfo?.(row.player);
      return info ?? fail(400, 'Unable to register with these details.');
    },
    async login(input: unknown, client: string) {
      await throttle(`address:${client}`, ADDRESS_LIMIT, WINDOW);
      const data = fields(input, ['username', 'password']), name = username(data.username);
      if (typeof data.password !== 'string' || new TextEncoder().encode(data.password).length > 512) return fail(401, 'Invalid username or password.');
      // Only failures count against an account: guessers are locked out from their own network (and, in
      // bulk, from everywhere), but the owner's successful sign-ins never use the budget up.
      const failures = [`fail:${name}:${client}`, `fail:${name}`], limits = [FAILS_PER_NETWORK, FAILS_PER_ACCOUNT];
      await Promise.all(failures.map((scope, i) => throttle.peek(scope, limits[i], WINDOW)));
      const found = await accountByName(name);
      const verified = await verifyPassword(data.password, await pepper(), found?.record.passwordHash, options.iterations);
      // Re-read after hashing so a concurrent reset or disable cannot mint a valid session.
      const active = found && await readAccount(found.record.id);
      if (!verified || !active || active.record.disabled || active.record.passwordHash !== found!.record.passwordHash || !(await roster(active.record.playerId))) {
        await Promise.all(failures.map((scope, i) => throttle(scope, limits[i], WINDOW))).catch(() => {});
        return fail(401, 'Invalid username or password.');
      }
      return session(active.record);
    },
    async logout(token: string) {
      const k = key.session(await sha256(token));
      const s = await json<SessionRecord>(k);
      if (!s) return; // Unknown or already ended: nothing to delete, so forged cookies cost one read.
      await kv.delete(k);
      const account = await readAccount(s.account);
      if (account) await revoke(account.record);
    },
    async list(token: string) {
      await requireOrganizer(token);
      const names = (await kv.list('usr-')).map(k => k.slice('usr-'.length));
      const rows = await Promise.all(names.map(accountByName));
      return rows.filter(r => !!r).map(r => ({ ...publicAccount(r!.record), disabled: r!.record.disabled }))
        .sort((a, b) => a.username.localeCompare(b.username));
    },
    async issueRecovery(token: string, accountId: string) {
      const issuer = (await requireOrganizer(token)).account.id;
      await throttle(`recovery-issuer:${issuer}`, 10, WINDOW);
      const target = await readAccount(accountId);
      if (!target || target.record.disabled || !(await roster(target.record.playerId))) return fail(400, 'Account is unavailable for recovery.');
      const code = secret(), expiresAt = now() + 15 * 60000;
      // Replacing the pending recovery invalidates any earlier code.
      const hash = await sha256(code);
      if (!(await writeAccount(target.version, { ...target.record, recovery: { hash, issuer, expiresAt } }))) return fail(409, 'The account changed. Please retry.');
      await kv.add(key.recovery(hash), target.record.id, { ttl: 3600 });
      return { code, expiresAt };
    },
    async revokeRecovery(token: string, accountId: string) {
      await requireOrganizer(token);
      const target = await readAccount(accountId);
      if (target?.record.recovery && !(await writeAccount(target.version, { ...target.record, recovery: null }))) return fail(409, 'The account changed. Please retry.');
    },
    async recover(input: unknown, client: string) {
      await throttle(`address:${client}`, ADDRESS_LIMIT, WINDOW);
      const data = fields(input, ['code', 'password']); validatePassword(data.password); await screenPassword(data.password);
      if (typeof data.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.code)) return fail(400, 'Invalid or expired recovery code.');
      const hash = await sha256(data.code);
      // The hash-keyed index finds the account in one read; the account record stays authoritative.
      const accountId = await kv.get(key.recovery(hash));
      const target = accountId ? await readAccount(accountId) : null;
      const pending = target?.record.recovery?.hash === hash ? target.record.recovery : null;
      const issuer = pending && await readAccount(pending.issuer);
      if (!target || !pending || pending.expiresAt <= now() || target.record.disabled || !issuer || issuer.record.disabled || !issuer.record.organizer || !(await roster(target.record.playerId))) return fail(400, 'Invalid or expired recovery code.');
      const passwordHash = await hashPassword(data.password, await pepper(), options.iterations);
      // The versioned write makes the code single-use even if two resets race.
      if (!(await writeAccount(target.version, { ...target.record, passwordHash, recovery: null, epoch: target.record.epoch + 1 }))) return fail(400, 'Invalid or expired recovery code.');
      await revoke(target.record);
      return { recovered: true };
    },
    async disable(token: string, accountId: string) {
      await requireOrganizer(token);
      const target = await readAccount(accountId);
      if (!target) return fail(404, 'Account not found.');
      if (target.record.organizer && !target.record.disabled) {
        const others = (await this.list(token)).filter(a => a.organizer && !a.disabled && a.id !== accountId);
        if (!others.length) return fail(400, 'Cannot disable the last organizer.');
      }
      if (!(await writeAccount(target.version, { ...target.record, disabled: true, recovery: null, epoch: target.record.epoch + 1 }))) return fail(409, 'The account changed. Please retry.');
      await kv.put(key.enrollmentLatest(target.record.playerId), 'revoked');
      await revoke(target.record);
    },
  };
}
export type EdgeAccounts = ReturnType<typeof createEdgeAccounts>;
