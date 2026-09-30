import { afterEach, expect, test, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createAccountAuth } from '../server/auth';
import { hashPassword, validatePassword } from '../server/passwords';
const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.unstubAllGlobals(); });
const blocked = '12345678901234567890';
const good = 'Several quiet rivers meet here!';
test('rejects a known breached password that meets the length rule without a network request', () => {
 const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
 expect(() => validatePassword(blocked)).toThrow('different password');
 expect(() => validatePassword('PASSWORDPASSWORD')).toThrow('different password');
 expect(() => validatePassword(good)).not.toThrow();
 expect(() => validatePassword('My passwordpassword is only an example')).not.toThrow();
 expect(fetch).not.toHaveBeenCalled();
});
test('screening registration and recovery preserves unused codes, sessions and existing passwords on rejection', async () => {
 const db = new DatabaseSync(':memory:'); databases.push(db);
 const auth = createAccountAuth({ db, playerIds: ['synthetic'] });
 const invite = auth.enroll('synthetic', true);
 await expect(auth.register({ username: 'synthetic', password: blocked, enrollment: invite.code }, 'test')).rejects.toMatchObject({ status: 400 });
 const session = await auth.register({ username: 'synthetic', password: good, enrollment: invite.code }, 'test');
 const recovery = auth.issueRecovery(session.token, session.account.id);
 await expect(auth.recover({ code: recovery.code, password: blocked }, 'test')).rejects.toMatchObject({ status: 400 });
 expect(auth.current(session.token).account.id).toBe(session.account.id);
 const stillValid = await auth.login({ username: 'synthetic', password: good }, 'test');
 expect(stillValid.account.id).toBe(session.account.id);
 await expect(auth.recover({ code: recovery.code, password: 'Another quiet river meets here!' }, 'test')).resolves.toEqual({ recovered: true });
}, 15000);

test('existing passwords remain case-sensitive and usable after screening policy changes', async () => {
 const db = new DatabaseSync(':memory:'); databases.push(db);
 const auth = createAccountAuth({ db, playerIds: ['legacy'] });
 const stored = await hashPassword('PASSWORDPASSWORD');
 db.prepare('INSERT INTO accounts(id, username, player, password_hash, organizer) VALUES (?, ?, ?, ?, 0)').run('legacy-id', 'legacy', 'legacy', stored);
 const login = await auth.login({ username: 'legacy', password: 'PASSWORDPASSWORD' }, 'test');
 expect(login.account.playerId).toBe('legacy');
 await expect(auth.login({ username: 'legacy', password: 'passwordpassword' }, 'test')).rejects.toMatchObject({ status: 401 });
}, 15000);
