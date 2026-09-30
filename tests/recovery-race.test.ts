import { expect, test, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createAccountAuth } from '../server/auth';
import * as passwords from '../server/passwords';
test('an old-password login completing after recovery cannot mint a session', async () => {
 const db = new DatabaseSync(':memory:');
 const auth = createAccountAuth({ db, playerIds: ['host'] });
 const oldPassword = 'Original synthetic password!';
 const host = await auth.register({ username: 'organizer', password: oldPassword, enrollment: auth.enroll('host', true).code }, 'test');
 const code = auth.issueRecovery(host.token, host.account.id);
 let ready!: () => void, release!: () => void;
 const verified = new Promise<void>(resolve => ready = resolve), paused = new Promise<void>(resolve => release = resolve);
 const original = passwords.verifyPassword;
 const spy = vi.spyOn(passwords, 'verifyPassword').mockImplementation(async (...args) => { const result = await original(...args); ready(); await paused; return result; });
 try {
  const login = auth.login({ username: 'organizer', password: oldPassword }, 'test').then(value => ({ value }), error => ({ error }));
  await verified;
  await auth.recover({ code: code.code, password: 'Replacement synthetic password!' }, 'test');
  release(); expect(await login).toMatchObject({ error: { status: 401 } });
  expect(db.prepare('SELECT COUNT(*) AS n FROM account_sessions').get()!.n).toBe(0);
 } finally { release(); spy.mockRestore(); db.close(); }
}, 15000);
