import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoomService } from '../server/service';
import { createRoomServer } from '../server/http';
import type { RoomCommand, RoomEntry, RoomReply, RoomView } from '../src/rooms/types';
import { acceptanceDataset } from './fixtures/room-roster';
import { COST } from '../src/game/rules';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'edge-acceptance-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'rooms.sqlite');
  let base = '';
  let stop = async () => {};
  async function start() {
    const service = createRoomService({ dataset: acceptanceDataset(101), databasePath });
    const server = createRoomServer({ service, distDir: dir });
    stop = async () => {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } finally { service.close(); }
    };
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  cleanup.push(() => stop());
  await start();
  async function request<T>(path: string, body?: unknown, token?: string, status = 200): Promise<T> {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', origin: base,
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    // Do not include response bodies, invitations or session tokens in diagnostics.
    expect(response.status).toBe(status);
    return await response.json() as T;
  }
  const path = (entry: RoomEntry) => `/api/rooms/${entry.session.code}`;
  return {
    request, path,
    create: () => request<RoomEntry>('/api/rooms', { name: 'Synthetic acceptance', hostId: 'team-0:player-0' }, undefined, 201),
    join: (host: RoomEntry, playerId: string) => request<RoomEntry>(path(host) + '/join', {
      inviteCode: host.invites!.find(invite => invite.playerId === playerId)!.code,
    }),
    view: (entry: RoomEntry) => request<RoomView>(path(entry), undefined, entry.session.token),
    command: (entry: RoomEntry, input: RoomCommand) => request<RoomReply>(path(entry) + '/commands', input, entry.session.token),
    restart: async () => { await stop(); await start(); },
  };
}

function converged(views: RoomView[]) {
  expect(views).toHaveLength(23);
  const board = JSON.stringify(views[0].state.cells);
  expect(views[0].state.cells).toHaveLength(10000);
  for (const view of views) {
    expect(view.revision).toBe(views[0].revision);
    expect(view.state.minute).toBe(views[0].state.minute);
    expect(JSON.stringify(view.state.cells)).toBe(board);
    expect(view.state.balance).toBe(view.state.earned - view.state.spent);
    expect(view.state.balance).toBeGreaterThanOrEqual(0);
    expect(view.dataset.players.map(player => player.id)).toEqual([view.state.playerId]);
  }
}
const paint: RoomCommand['command'] = { type: 'apply', tool: 'brush', x: 0, y: 0 };

test('full roster converges under contention, lost acknowledgments, restart and isolated room receipts', async () => {
  const api = await setup();
  const dataset = acceptanceDataset(101);
  expect(dataset.players).toHaveLength(23);
  const sizes = [...new Set(dataset.players.map(player => player.team))]
    .map(team => dataset.players.filter(player => player.team === team).length);
  expect(sizes.sort()).toEqual([1, 1, 1, 2, 3, 3, 3, 3, 3, 3]);
  const host = await api.create();
  const players = await Promise.all(dataset.players.map(player => api.join(host, player.id)));
  players.forEach((entry, index) => expect(entry.view.state.playerId).toBe(dataset.players[index].id));
  let views = await Promise.all(players.map(api.view));
  converged(views);
  expect(views[0].members.every(member => member.joined)).toBe(true);

  const replies = await Promise.all([0, 3].map(index => api.command(players[index], { id: 'contend', command: paint })));
  expect(replies.map(reply => reply.code)).toEqual(['OK', 'OK']);
  views = await Promise.all(players.map(api.view));
  converged(views);
  expect(views[0].state.spent + views[3].state.spent).toBe(COST.brush + COST.rival);
  expect([views[0].state.spent, views[3].state.spent].sort((a, b) => a - b)).toEqual([COST.brush, COST.rival]);
  const winner = views[0].state.cells[0].owner === 'team-0' ? 0 : 3;
  const loser = winner === 0 ? 3 : 0;
  const teammate = players[winner + 1];
  const beforeRepaint = await api.view(teammate);
  const repaint = await api.command(teammate, { id: 'teammate', command: paint });
  expect(repaint.code).toBe('NO_CHANGE');
  expect(repaint.view).toEqual(beforeRepaint);
  expect((await api.command(players[winner], { id: 'shield-buy', command: { type: 'buy', item: 'shield' } })).code).toBe('OK');
  const shield = await api.command(players[winner], { id: 'shield-use', command: { type: 'apply', tool: 'shield', x: 0, y: 0 } });
  expect(shield.code).toBe('OK');
  expect(shield.view.state.cells[0].shieldUntil).toBe(120);
  const beforeAttack = await api.view(players[loser]);
  const blocked = await api.command(players[loser], { id: 'blocked', command: paint });
  expect(blocked.code).toBe('NO_CHANGE');
  expect(blocked.view).toEqual(beforeAttack);
  const denied = await api.command(players[1], { id: 'not-host', command: { type: 'advance', toMinute: 1440 } });
  expect(denied.code).toBe('HOST_ONLY');
  expect(denied.view.state.minute).toBe(0);

  const purchase = { id: 'lost-ack', command: { type: 'buy', item: 'bomb' } } as const;
  const beforePurchase = await api.view(players[2]);
  // Drain and discard the successful response; the retrying client has no acknowledgment state.
  await api.command(players[2], purchase);
  const secondSession = await api.join(host, dataset.players[2].id);
  const retried = await api.command(secondSession, purchase);
  expect(retried.code).toBe('OK');
  expect(retried.view.state.spent).toBe(beforePurchase.state.spent + COST.bomb);
  expect(retried.view.state.inventory.bomb).toBe(beforePurchase.state.inventory.bomb + 1);
  const beforeRestart = await Promise.all(players.map(api.view));
  await api.restart();
  expect(await Promise.all(players.map(api.view))).toEqual(beforeRestart);
  const afterRestartSession = await api.join(host, dataset.players[2].id);
  expect(await api.command(afterRestartSession, purchase)).toEqual(retried);

  const other = await api.create();
  const otherPlayer = await api.join(other, dataset.players[2].id);
  const untouched = await api.view(other);
  expect(untouched.state.cells.every(cell => cell.owner === null && cell.shieldUntil === 0)).toBe(true);
  expect(untouched.state.balance).toBe(20000);
  for (const [source, target] of [[host, other], [other, host]]) {
    await api.request(api.path(target) + '/join', { inviteCode: source.invites![2].code }, undefined, 403);
    await api.request(api.path(target), undefined, source.session.token, 401);
  }
  expect((await api.command(otherPlayer, purchase)).view.state.inventory.bomb).toBe(1);
  expect((await api.command(otherPlayer, purchase)).view.state.spent).toBe(COST.bomb);
  expect((await api.command(other, { id: 'contend', command: paint })).view.state.spent).toBe(COST.brush);
  expect(await Promise.all(players.map(api.view))).toEqual(beforeRestart);
  const otherBeforeRounds = await Promise.all([other, otherPlayer].map(api.view));

  const expected = beforeRestart.map(view => ({ spent: view.state.spent, inventory: { ...view.state.inventory } }));
  let revision = beforeRestart[0].revision;
  const started = performance.now();
  for (let round = 0; round < 100; round++) {
    const results = await Promise.all(players.map((entry, index) => {
      let command: RoomCommand['command'];
      if (index === 0) command = { type: 'advance', toMinute: (round + 1) * 1440 };
      else if ((round + index) % 3 === 0) {
        const cell = 100 + round * 23 + index;
        command = { type: 'apply', tool: 'brush', x: cell % 100, y: Math.floor(cell / 100) };
        expected[index].spent += COST.brush;
      } else {
        const item = (round + index) % 3 === 1 ? 'bomb' : 'shield';
        command = { type: 'buy', item };
        expected[index].spent += COST.bomb;
        expected[index].inventory[item]++;
      }
      return api.command(entry, { id: `round-${round}`, command });
    }));
    expect(results.every(reply => reply.code === 'OK')).toBe(true);
    revision += 23;
    views = await Promise.all(players.map(api.view));
    converged(views);
    expect(views[0].revision).toBe(revision);
    views.forEach((view, index) => {
      expect(view.state.minute).toBe((round + 1) * 1440);
      expect(view.state.earned).toBe((round + 2) * 20000);
      expect(view.state.spent).toBe(expected[index].spent);
      if (index > 0 && (round + index) % 3 === 0) {
        expect(view.state.cells[100 + round * 23 + index].owner).toBe(dataset.players[index].team);
      }
      expect(view.state.inventory).toEqual(expected[index].inventory);
    });
  }
  console.info(`M1 local observation: Node ${process.version}, 23 HTTP identities, 100 rounds, 2300 mixed commands, 2300 convergence reads, ${Math.round(performance.now() - started)} ms (includes assertions).`);
  expect(await Promise.all([other, otherPlayer].map(api.view))).toEqual(otherBeforeRounds);
  await api.restart();
  expect(await Promise.all(players.map(api.view))).toEqual(views);
}, 120000);
