import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoomService } from '../server/service';
import type { Dataset } from '../src/game/types';
import { COST } from '../src/game/rules';

export const roomData: Dataset = { dates: ['2026-07-01', '2026-07-02'], players: [
  { id: 'a', name: 'Alice', team: 'Amber Foxes', totalSteps: 7000, dailyGoal: 3000, days: { '2026-07-01': 5000, '2026-07-02': 2000 } },
  { id: 'b', name: 'Bob', team: 'Rival', totalSteps: 9000, dailyGoal: 3000, days: { '2026-07-01': 6000, '2026-07-02': 3000 } },
  { id: 'c', name: 'Cara', team: 'Amber Foxes', totalSteps: 4300, dailyGoal: 3000, days: { '2026-07-01': 300, '2026-07-02': 4000 } },
] };
const services: ReturnType<typeof createRoomService>[] = [];
function service(databasePath = ':memory:') { const s = createRoomService({ dataset: roomData, databasePath }); services.push(s); return s; }
afterEach(() => { services.splice(0).forEach(s => s.close()); });
const paint = (id: string) => ({ id, command: { type: 'apply', tool: 'brush', x: 0, y: 0 } } as const);
test('personal invitations bind identities, isolate history and keep existing invitations host-only', () => {
  const s = service(); const host = s.create({ name: 'Room', hostId: 'a' });
  const bob = s.join(host.session.code, { inviteCode: host.invites!.find(i => i.playerId === 'b')!.code });
  expect(bob.view.state.playerId).toBe('b'); expect(bob.view.state.balance).toBe(6000);
  expect(bob.view.dataset.players.map(p => p.id)).toEqual(['b']); expect(bob.invites).toBeUndefined();
  expect(bob.view.members.filter(p => p.joined).map(p => p.id)).toEqual(['a', 'b']);
  expect(bob.view.revision).toBeGreaterThan(host.view.revision);
  expect(() => s.invites(host.session.code, bob.session.token)).toThrow(/host/i);
  expect(() => s.view(host.session.code, 'forged', bob.view.revision)).toThrow(/session/i);
  const other = s.create({ name: 'Other', hostId: 'a' });
  expect(() => s.join(other.session.code, { inviteCode: host.invites![1].code })).toThrow(/invite/i);
});
test('separate wallets converge on shared ownership and teammate painting costs nothing', () => {
  const s = service(); const h = s.create({ name: 'Room', hostId: 'a' });
  const b = s.join(h.session.code, { inviteCode: h.invites!.find(i => i.playerId === 'b')!.code });
  expect(s.command(h.session.code, h.session.token, paint('paint-a')).view.state.balance).toBe(5000 - COST.brush);
  expect(s.command(h.session.code, b.session.token, paint('paint-b')).view.state.balance).toBe(6000 - COST.rival);
  const again = s.command(h.session.code, b.session.token, paint('paint-b-again'));
  expect(again.code).toBe('NO_CHANGE'); expect(again.view.state.balance).toBe(6000 - COST.rival);
  const hostView = s.view(h.session.code, h.session.token);
  expect(hostView).toMatchObject({ state: { balance: 5000 - COST.brush, competitive: true } });
  expect('state' in hostView && hostView.state.cells[0].owner).toBe('Rival');
});
test('host alone advances every personal wallet exactly once', () => {
  const s = service(); const h = s.create({ name: 'Room', hostId: 'a' });
  const b = s.join(h.session.code, { inviteCode: h.invites!.find(i => i.playerId === 'b')!.code });
  const advance = { id: 'day', command: { type: 'advance', toMinute: 1440 } } as const;
  expect(s.command(h.session.code, b.session.token, advance).code).toBe('HOST_ONLY');
  const result = s.command(h.session.code, h.session.token, advance);
  expect(result.view.state.balance).toBe(7000);
  expect(s.command(h.session.code, h.session.token, { ...advance, id: 'day-again' }).code).toBe('NO_CHANGE');
  expect(s.view(h.session.code, b.session.token)).toMatchObject({ state: { balance: 9000, minute: 1440 } });
});
test('durable receipts prevent retry spending and conflicting payload reuse returns conflict', () => {
  const s = service(); const h = s.create({ name: 'Room', hostId: 'a' });
  const buy = { id: 'purchase', command: { type: 'buy', item: 'bomb' } } as const;
  const first = s.command(h.session.code, h.session.token, buy);
  s.command(h.session.code, h.session.token, paint('later'));
  const retry = s.command(h.session.code, h.session.token, buy);
  expect(retry.view.state.inventory.bomb).toBe(1); expect(retry.view.state.balance).toBe(5000 - COST.bomb - COST.brush);
  expect(retry.view.revision).toBeGreaterThan(first.view.revision);
  expect(() => s.command(h.session.code, h.session.token, { ...buy, command: { type: 'buy', item: 'shield' } })).toThrow(/different/i);
});
test('rejected purchases are remembered even after the wallet gains funds', () => {
  const s = service(); const h = s.create({ name: 'Room', hostId: 'c' });
  s.command(h.session.code, h.session.token, { id: 'first', command: { type: 'buy', item: 'bomb' } });
  const failed = { id: 'failed', command: { type: 'buy', item: 'bomb' } } as const;
  expect(s.command(h.session.code, h.session.token, failed).code).toBe('INSUFFICIENT_PAINT');
  s.command(h.session.code, h.session.token, { id: 'day', command: { type: 'advance', toMinute: 1440 } });
  const retry = s.command(h.session.code, h.session.token, failed);
  expect(retry.code).toBe('INSUFFICIENT_PAINT'); expect(retry.view.state.balance).toBe(300 + 4000 - COST.bomb); expect(retry.view.state.inventory.bomb).toBe(1);
});
test('rooms, invitations, sessions and receipts survive reopening SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-room-'));
  try {
    const path = join(dir, 'rooms.sqlite'); const s = service(path); const h = s.create({ name: 'Durable', hostId: 'a' });
    s.command(h.session.code, h.session.token, paint('saved')); s.close();
    const reopened = service(path);
    const retry = reopened.command(h.session.code, h.session.token, paint('saved'));
    expect(retry.view.state.balance).toBe(5000 - COST.brush); expect(retry.view.state.cells[0].owner).toBe('Amber Foxes');
    expect(reopened.invites(h.session.code, h.session.token)).toEqual({ invites: h.invites });
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('roster rejects a fourth teammate and forged command authority', () => {
  const players = Array.from({ length: 4 }, (_, i) => ({ ...roomData.players[0], id: String(i) }));
  expect(() => createRoomService({ dataset: { ...roomData, players }, databasePath: ':memory:' })).toThrow(/three/i);
  const s = service(); const h = s.create({ name: 'Room', hostId: 'a' });
  expect(() => s.command(h.session.code, h.session.token, { ...paint('bad'), playerId: 'b' } as never)).toThrow(/command/i);
  expect(() => s.command(h.session.code, h.session.token, { id: 'bad-time', command: { type: 'advance', toMinute: 1.2 } })).toThrow(/command/i);
});

test('logout durably revokes only the current session without removing progress or receipts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-logout-'));
  const path = join(dir, 'rooms.sqlite');
  let s = service(path);
  try {
    const host = s.create({ name: 'Logout', hostId: 'a' });
    const otherRoom = s.create({ name: 'Other room', hostId: 'a' });
    const samePlayer = s.join(host.session.code, { inviteCode: host.invites![0].code });
    const purchase = { id: 'before-logout', command: { type: 'buy', item: 'bomb' } } as const;
    const saved = s.command(host.session.code, host.session.token, purchase);
    s.logout(otherRoom.session.code, host.session.token);
    expect(s.view(host.session.code, host.session.token)).toEqual(saved.view);
    s.logout(host.session.code, host.session.token);
    s.logout(host.session.code, host.session.token); // Lost acknowledgment can be retried.
    const rejected = () => {
      expect(() => s.view(host.session.code, host.session.token, saved.view.revision)).toThrow(/session/i);
      expect(() => s.command(host.session.code, host.session.token, purchase)).toThrow(/session/i);
      expect(() => s.invites(host.session.code, host.session.token)).toThrow(/session/i);
    };
    rejected();
    s.close(); s = service(path);
    rejected();
    expect(s.view(host.session.code, samePlayer.session.token)).toEqual(saved.view);
    expect(s.view(otherRoom.session.code, otherRoom.session.token)).toEqual(otherRoom.view);
    const rejoined = s.join(host.session.code, { inviteCode: host.invites![0].code });
    expect(s.command(host.session.code, rejoined.session.token, purchase)).toEqual(saved);
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});
