import { expect, test } from 'vitest';
import { createRoomService } from '../server/service';
import { acceptanceDataset } from './fixtures/room-roster';
import { COST } from '../src/game/rules';

test('accounts authorize room identity, organizer creation, private history and revocation', async () => {
  const dataset = acceptanceDataset();
  const service = createRoomService({ dataset, databasePath: ':memory:', accessMode: 'accounts' });
  try {
    const auth = service.accounts!;
    const register = (index: number, organizer = false) => auth.register({ username: `player${index}`, password: 'Synthetic canvas password!', enrollment: auth.enroll(dataset.players[index].id, organizer).code }, 'test');
    const host = await register(0, true), member = await register(1);
    expect(() => auth.createRoom(member.token, { name: 'No' })).toThrow('organizer');
    expect(() => auth.createRoom(host.token, { name: 'No', hostId: member.account.playerId })).toThrow();
    const view = auth.createRoom(host.token, { name: 'Account room' });
    expect(auth.listRooms(member.token)).toEqual([{ code: view.code, name: 'Account room' }]);
    const other = auth.joinRoom(member.token, view.code);
    expect(other.state.playerId).toBe(member.account.playerId);
    expect(other.dataset.players).toEqual([dataset.players[1]]);
    expect(() => service.create({ name: 'Bypass', hostId: host.account.playerId })).toThrow();
    expect(() => service.roster()).toThrow();
    expect(auth.commandRoom(member.token, view.code, { id: 'advance', command: { type: 'advance', toMinute: 1440 } }).code).toBe('HOST_ONLY');
    const buy = { id: 'purchase', command: { type: 'buy', item: 'bomb' } } as const;
    expect(auth.commandRoom(member.token, view.code, buy).code).toBe('OK');
    const spent = auth.commandRoom(member.token, view.code, buy).view.state.spent;
    expect(spent).toBe(COST.bomb);
    auth.disable(host.token, member.account.id);
    expect(() => auth.viewRoom(member.token, view.code)).toThrow('Sign in');
    expect(() => auth.commandRoom(member.token, view.code, buy)).toThrow('Sign in');
    expect(auth.viewRoom(host.token, view.code)).toHaveProperty('state.playerId', host.account.playerId);
  } finally { service.close(); }
}, 15000);

test('account sessions and revocation survive restart; demo databases cannot be promoted', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'edgecanvas-accounts-')), databasePath = join(dir, 'accounts.sqlite');
  const dataset = acceptanceDataset();
  const open = () => createRoomService({ dataset, databasePath, accessMode: 'accounts' });
  let service = open();
  try {
    const auth = service.accounts!;
    const user = await auth.register({ username: 'persistent', password: 'Synthetic canvas password!', enrollment: auth.enroll(dataset.players[0].id, true).code }, 'test');
    const room = auth.createRoom(user.token, { name: 'Restart' });
    service.close();
    expect(() => createRoomService({ dataset, databasePath })).toThrow('separate database');
    service = open(); expect(service.accounts!.viewRoom(user.token, room.code)).toHaveProperty('name', 'Restart');
    service.accounts!.logout(user.token); service.close(); service = open();
    expect(() => service.accounts!.current(user.token)).toThrow('Sign in');
    const localPath = join(dir, 'local.sqlite');
    const local = createRoomService({ dataset, databasePath: localPath }); local.create({ name: 'Local', hostId: dataset.players[0].id }); local.close();
    expect(() => createRoomService({ dataset, databasePath: localPath, accessMode: 'accounts' })).toThrow('separate database');
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
}, 15000);
