import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createAccountAuth } from '../server/auth';
const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));
const password = 'Original synthetic password!';
const replacement = 'Replacement synthetic password!';
async function setup() {
 const db = new DatabaseSync(':memory:'); dbs.push(db); let time = 1000;
 const auth = createAccountAuth({ db, playerIds: ['host', 'member'], now: () => time });
 const register = (player: string, organizer: boolean) => auth.register({ username: player, password, enrollment: auth.enroll(player, organizer).code }, 'test');
 const host = await register('host', true), member = await register('member', false);
 return { db, auth, host, member, advance: () => time += 15 * 60000 };
}
test('recovery binds immutable identity, hashes codes, revokes sessions and requires fresh login', async () => {
 const { db, auth, host, member } = await setup();
 const code = auth.issueRecovery(host.token, member.account.id);
 expect(JSON.stringify(db.prepare('SELECT * FROM recoveries').all())).not.toContain(code.code);
 await expect(auth.recover({ code: code.code, password: replacement, playerId: 'host' }, 'test')).rejects.toMatchObject({ status: 400 });
 await expect(auth.recover({ code: code.code, password: replacement }, 'test')).resolves.toEqual({ recovered: true });
 expect(() => auth.current(member.token)).toThrow('Sign in');
 await expect(auth.login({ username: 'member', password }, 'test')).rejects.toMatchObject({ status: 401 });
 const login = await auth.login({ username: 'member', password: replacement }, 'test');
 expect(login.account).toEqual(member.account);
 await expect(auth.recover({ code: code.code, password }, 'test')).rejects.toMatchObject({ status: 400 });
}, 15000);
test('only organizers issue/revoke codes; expiry, replacement and disable invalidate them', async () => {
 const { auth, host, member, advance } = await setup();
 expect(() => auth.issueRecovery(member.token, host.account.id)).toThrow('organizer');
 const old = auth.issueRecovery(host.token, member.account.id);
 const fresh = auth.issueRecovery(host.token, member.account.id);
 await expect(auth.recover({ code: old.code, password: replacement }, 'test')).rejects.toThrow('recovery');
 advance(); await expect(auth.recover({ code: fresh.code, password: replacement }, 'test')).rejects.toThrow('recovery');
 const revoked = auth.issueRecovery(host.token, member.account.id); auth.revokeRecovery(host.token, member.account.id);
 await expect(auth.recover({ code: revoked.code, password: replacement }, 'test')).rejects.toThrow('recovery');
 const disabled = auth.issueRecovery(host.token, member.account.id); auth.disable(host.token, member.account.id);
 await expect(auth.recover({ code: disabled.code, password: replacement }, 'test')).rejects.toThrow('recovery');
 expect(() => auth.issueRecovery(host.token, member.account.id)).toThrow();
}, 15000);
test('concurrent recovery consumption succeeds once', async () => {
 const { auth, host, member } = await setup();
 const code = auth.issueRecovery(host.token, member.account.id);
 const results = await Promise.allSettled([replacement, password].map(password => auth.recover({ code: code.code, password }, 'test')));
 expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
}, 15000);
