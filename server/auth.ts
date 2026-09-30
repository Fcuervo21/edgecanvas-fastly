import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { RoomError } from './errors';
import { hashPassword, validatePassword, verifyPassword } from './passwords';

export interface Account { id: string; username: string; playerId: string; organizer: boolean }
export const ACCOUNT_SESSION_MS = 8 * 60 * 60 * 1000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const fail = (status: number, message: string): never => { throw new RoomError(status, message); };
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) return fail(400, 'Invalid account request.');
  return value as Record<string, unknown>;
}
function username(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(value)) return fail(400, 'Use a username of 3–32 letters, numbers, dots, underscores or hyphens.');
  return value.toLowerCase();
}
export function csrfToken(token: string): string { return digest(`edgecanvas-csrf:${token}`); }
export function validCsrf(token: string, supplied: unknown): boolean {
  return typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied)
    && timingSafeEqual(Buffer.from(csrfToken(token), 'hex'), Buffer.from(supplied, 'hex'));
}
export function createAccountAuth(options: { db: DatabaseSync; playerIds: string[]; now?: () => number;
  /** Called after a commit that revoked sessions, so live streams for that player can be closed. */
  onRevoke?: (playerId: string) => void }) {
  const { db } = options; const now = options.now ?? Date.now;
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, player TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, organizer INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS enrollments (
    hash TEXT PRIMARY KEY, player TEXT NOT NULL, organizer INTEGER NOT NULL, expires INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS account_sessions (hash TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS recoveries (hash TEXT PRIMARY KEY, account TEXT NOT NULL, issuer TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function throttle(scope: string, limit: number) {
    const at = now(); db.prepare('DELETE FROM auth_attempts WHERE expires <= ?').run(at);
    const key = digest(scope), row = db.prepare('SELECT count FROM auth_attempts WHERE key = ?').get(key);
    if (row && Number(row.count) >= limit) return fail(429, 'Too many attempts. Try again in 15 minutes.');
    db.prepare(`INSERT INTO auth_attempts VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1`).run(key, at + 15 * 60000);
  }
  function publicAccount(row: Record<string, unknown>): Account {
    return { id: String(row.id), username: String(row.username), playerId: String(row.player), organizer: row.organizer === 1 };
  }
  function session(account: Account) {
    const token = secret(), expiresAt = now() + ACCOUNT_SESSION_MS;
    db.prepare('DELETE FROM account_sessions WHERE expires <= ?').run(now());
    db.prepare('INSERT INTO account_sessions VALUES (?, ?, ?)').run(digest(token), account.id, expiresAt);
    return { account, token, expiresAt, csrfToken: csrfToken(token) };
  }
  function current(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return fail(401, 'Sign in to continue.');
    const row = db.prepare(`SELECT a.*, s.expires FROM account_sessions s JOIN accounts a ON a.id = s.account
      WHERE s.hash = ? AND s.expires > ? AND a.disabled = 0`).get(digest(token), now());
    if (!row || !options.playerIds.includes(String(row.player))) return fail(401, 'Sign in to continue.');
    return { account: publicAccount(row), expiresAt: Number(row.expires), csrfToken: csrfToken(token) };
  }
  function requireOrganizer(token: string) {
    const result = current(token);
    if (!result.account.organizer) return fail(403, 'Only an organizer can do that.');
    return result;
  }
  function enrollment(code: unknown) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return fail(400, 'Unable to register with these details.');
    const row = db.prepare('SELECT * FROM enrollments WHERE hash = ? AND consumed = 0 AND revoked = 0 AND expires > ?').get(digest(code), now());
    if (!row || !options.playerIds.includes(String(row.player))) return fail(400, 'Unable to register with these details.');
    return row;
  }
  function recovery(code: unknown) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return fail(400, 'Invalid or expired recovery code.');
    const row = db.prepare(`SELECT r.account FROM recoveries r JOIN accounts a ON a.id = r.account
      JOIN accounts issuer ON issuer.id = r.issuer WHERE r.hash = ? AND r.expires > ?
      AND a.disabled = 0 AND issuer.disabled = 0 AND issuer.organizer = 1`).get(digest(code), now());
    if (!row) return fail(400, 'Invalid or expired recovery code.');
    const target = db.prepare('SELECT player FROM accounts WHERE id = ?').get(String(row.account))!;
    if (!options.playerIds.includes(String(target.player))) return fail(400, 'Invalid or expired recovery code.');
    return String(row.account);
  }
  return {
    current, requireOrganizer,
    issueRecovery(token: string, accountId: string) {
      return transaction(() => {
        const issuer = requireOrganizer(token).account.id;
        throttle(`recovery-issuer:${issuer}`, 10);
        const target = db.prepare('SELECT player FROM accounts WHERE id = ? AND disabled = 0').get(accountId);
        if (!target || !options.playerIds.includes(String(target.player))) return fail(400, 'Account is unavailable for recovery.');
        const code = secret(), expiresAt = now() + 15 * 60000;
        db.prepare('DELETE FROM recoveries WHERE account = ? OR expires <= ?').run(accountId, now());
        db.prepare('INSERT INTO recoveries VALUES (?, ?, ?, ?)').run(digest(code), accountId, issuer, expiresAt);
        return { code, expiresAt };
      });
    },
    revokeRecovery(token: string, accountId: string) {
      requireOrganizer(token);
      db.prepare('DELETE FROM recoveries WHERE account = ?').run(accountId);
    },
    async recover(input: unknown, client: string) {
      throttle(`address:${client}`, 30);
      const data = fields(input, ['code', 'password']); validatePassword(data.password);
      recovery(data.code);
      const passwordHash = await hashPassword(data.password);
      const player = transaction(() => {
        const accountId = recovery(data.code);
        db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(passwordHash, accountId);
        db.prepare('DELETE FROM account_sessions WHERE account = ?').run(accountId);
        db.prepare('DELETE FROM recoveries WHERE account = ?').run(accountId);
        return String(db.prepare('SELECT player FROM accounts WHERE id = ?').get(accountId)!.player);
      });
      options.onRevoke?.(player);
      return { recovered: true };
    },
    // Local organizer tooling only: never expose this function as unauthenticated HTTP.
    enroll(playerId: string, organizer = false, lifetimeMs = 24 * 60 * 60000) {
      if (!options.playerIds.includes(playerId) || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 7 * 24 * 60 * 60000) return fail(400, 'Invalid enrollment settings.');
      if (db.prepare('SELECT id FROM accounts WHERE player = ?').get(playerId)) return fail(409, 'That participant already has an account.');
      return transaction(() => {
        db.prepare('UPDATE enrollments SET revoked = 1 WHERE player = ? AND consumed = 0').run(playerId);
        const code = secret(), expiresAt = now() + lifetimeMs;
        db.prepare('INSERT INTO enrollments(hash, player, organizer, expires) VALUES (?, ?, ?, ?)').run(digest(code), playerId, organizer ? 1 : 0, expiresAt);
        return { code, expiresAt, playerId };
      });
    },
    revokeEnrollment(code: string) { db.prepare('UPDATE enrollments SET revoked = 1 WHERE hash = ?').run(digest(code)); },
    async register(input: unknown, client: string) {
      throttle(`address:${client}`, 30);
      const data = fields(input, ['username', 'password', 'enrollment']);
      const name = username(data.username); validatePassword(data.password);
      enrollment(data.enrollment);
      const passwordHash = await hashPassword(data.password);
      return transaction(() => {
        const invite = enrollment(data.enrollment);
        if (db.prepare('SELECT id FROM accounts WHERE username = ? OR player = ?').get(name, String(invite.player))) return fail(400, 'Unable to register with these details.');
        const account = { id: randomUUID(), username: name, playerId: String(invite.player), organizer: invite.organizer === 1 };
        db.prepare('INSERT INTO accounts(id, username, player, password_hash, organizer) VALUES (?, ?, ?, ?, ?)').run(account.id, name, account.playerId, passwordHash, account.organizer ? 1 : 0);
        db.prepare('UPDATE enrollments SET consumed = 1 WHERE hash = ?').run(digest(String(data.enrollment)));
        return session(account);
      });
    },
    async login(input: unknown, client: string) {
      throttle(`address:${client}`, 30);
      const data = fields(input, ['username', 'password']), name = username(data.username);
      if (typeof data.password !== 'string' || Buffer.byteLength(data.password) > 512) return fail(401, 'Invalid username or password.');
      throttle(`username:${name}`, 5);
      const row = db.prepare('SELECT * FROM accounts WHERE username = ?').get(name);
      const verified = await verifyPassword(data.password, row ? String(row.password_hash) : undefined);
      // Re-read after hashing so concurrent membership removal cannot mint a valid session.
      return transaction(() => {
        const active = row && db.prepare('SELECT * FROM accounts WHERE id = ? AND disabled = 0').get(String(row.id));
        if (!verified || !active || active.password_hash !== row!.password_hash || !options.playerIds.includes(String(active.player))) return fail(401, 'Invalid username or password.');
        return session(publicAccount(active));
      });
    },
    logout(token: string) {
      const row = db.prepare('SELECT a.player FROM account_sessions s JOIN accounts a ON a.id = s.account WHERE s.hash = ?').get(digest(token));
      db.prepare('DELETE FROM account_sessions WHERE hash = ?').run(digest(token));
      if (row) options.onRevoke?.(String(row.player));
    },
    list(token: string) {
      requireOrganizer(token);
      return db.prepare('SELECT id, username, player, organizer, disabled FROM accounts ORDER BY username').all()
        .map(row => ({ ...publicAccount(row), disabled: row.disabled === 1 }));
    },
    disable(token: string, accountId: string) {
      const player = transaction(() => {
        requireOrganizer(token);
        const target = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
        if (!target) return fail(404, 'Account not found.');
        if (target.organizer === 1 && target.disabled === 0 && Number(db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE organizer = 1 AND disabled = 0').get()!.count) === 1) return fail(400, 'Cannot disable the last organizer.');
        db.prepare('DELETE FROM recoveries WHERE account = ? OR issuer = ?').run(accountId, accountId);
        db.prepare('UPDATE accounts SET disabled = 1 WHERE id = ?').run(accountId);
        db.prepare('DELETE FROM account_sessions WHERE account = ?').run(accountId);
        db.prepare('UPDATE enrollments SET revoked = 1 WHERE player = ?').run(String(target.player));
        return String(target.player);
      });
      options.onRevoke?.(player);
    },
  };
}
