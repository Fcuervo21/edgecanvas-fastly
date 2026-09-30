import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createAccountAuth } from '../server/auth';

const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
const password = 'Synthetic river canvas password!';
function setup() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  let time = 1000000;
  const auth = createAccountAuth({ db, playerIds: ['p1', 'p2', 'p3'], now: () => time });
  return { db, auth, advance: (ms: number) => { time += ms; } };
}
test('registration requires assigned one-time enrollment and stores only salted password/token hashes', async () => {
  const { auth, db } = setup();
  const invite = auth.enroll('p1', true);
  const result = await auth.register({ username: 'Player.One', password, enrollment: invite.code }, 'client1');
  expect(result.account).toMatchObject({ username: 'player.one', playerId: 'p1', organizer: true });
  const account = db.prepare('SELECT * FROM accounts').get()!;
  expect(String(account.password_hash)).not.toContain(password);
  expect(String(account.password_hash)).toMatch(/^scrypt\$/);
  expect(JSON.stringify(db.prepare('SELECT * FROM account_sessions').all())).not.toContain(result.token);
  expect(JSON.stringify(db.prepare('SELECT * FROM enrollments').all())).not.toContain(invite.code);
  await expect(auth.register({ username: 'someone.else', password, enrollment: invite.code }, 'client2')).rejects.toMatchObject({ status: 400 });
  expect(auth.current(result.token).account.id).toBe(result.account.id);
}, 15000);
test('expired/revoked invitations and client-selected identities are rejected', async () => {
  const { auth, advance } = setup();
  const expired = auth.enroll('p1', false, 1000); advance(1000);
  await expect(auth.register({ username: 'player.one', password, enrollment: expired.code }, 'one')).rejects.toMatchObject({ status: 400 });
  const revoked = auth.enroll('p2'); auth.revokeEnrollment(revoked.code);
  await expect(auth.register({ username: 'player.two', password, enrollment: revoked.code }, 'two')).rejects.toMatchObject({ status: 400 });
  const valid = auth.enroll('p3');
  await expect(auth.register({ username: 'player.three', password, enrollment: valid.code, playerId: 'p1' }, 'three')).rejects.toMatchObject({ status: 400 });
}, 15000);
test('concurrent enrollment consumption admits only one account', async () => {
  const { auth, db } = setup(); const invite = auth.enroll('p1');
  const results = await Promise.allSettled(['first.user', 'second.user'].map(username => auth.register({ username, password, enrollment: invite.code }, username)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(db.prepare('SELECT COUNT(*) AS count FROM accounts').get()!.count).toBe(1);
}, 15000);
test('login errors do not disclose existence, sessions expire, and logout is repeatable', async () => {
  const { auth, advance } = setup();
  await auth.register({ username: 'player.one', password, enrollment: auth.enroll('p1').code }, 'register');
  for (const username of ['player.one', 'missing.user']) {
    await expect(auth.login({ username, password: 'Wrong synthetic password!' }, username)).rejects.toMatchObject({ status: 401, message: 'Invalid username or password.' });
  }
  const a = await auth.login({ username: 'PLAYER.ONE', password }, 'login1');
  const b = await auth.login({ username: 'player.one', password }, 'login2');
  auth.logout(a.token); auth.logout(a.token);
  expect(() => auth.current(a.token)).toThrow(/Sign in/);
  expect(auth.current(b.token).account.username).toBe('player.one');
  advance(8 * 60 * 60 * 1000);
  expect(() => auth.current(b.token)).toThrow(/Sign in/);
}, 15000);
test('organizers can disable membership, but ordinary users and the last organizer cannot', async () => {
  const { auth } = setup();
  const owner = await auth.register({ username: 'organizer', password, enrollment: auth.enroll('p1', true).code }, 'one');
  const member = await auth.register({ username: 'member.user', password, enrollment: auth.enroll('p2').code }, 'two');
  expect(() => auth.disable(member.token, owner.account.id)).toThrow(/organizer/i);
  expect(() => auth.disable(owner.token, owner.account.id)).toThrow(/last organizer/i);
  auth.disable(owner.token, member.account.id);
  expect(() => auth.current(member.token)).toThrow(/Sign in/);
  await expect(auth.login({ username: 'member.user', password }, 'three')).rejects.toMatchObject({ status: 401 });
}, 15000);
test('password length and persistent login throttling are enforced', async () => {
  const { auth, db } = setup(); const invite = auth.enroll('p1');
  await expect(auth.register({ username: 'player.one', password: 'short', enrollment: invite.code }, 'one')).rejects.toMatchObject({ status: 400 });
  for (let i = 0; i < 5; i++) await expect(auth.login({ username: 'missing.user', password }, 'attempts')).rejects.toMatchObject({ status: 401 });
  const reopened = createAccountAuth({ db, playerIds: ['p1', 'p2', 'p3'], now: () => 1000000 });
  await expect(reopened.login({ username: 'missing.user', password }, 'attempts')).rejects.toMatchObject({ status: 429 });
}, 15000);
