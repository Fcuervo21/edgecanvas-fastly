import { createGame, dispatch } from '../game/engine';
import type { Cell, Command, Dataset, GameState } from '../game/types';
import type { RoomMember, RoomReply, RoomView } from './types';
import { teamColor } from './colors';

export interface RoomDocument {
  code: string; name: string; hostId: string; revision: number; dataset: Dataset;
  members: RoomMember[]; cells: Cell[]; minute: number;
  wallets: Record<string, Omit<GameState, 'cells'>>;
}
export function createRoomDocument(dataset: Dataset, code: string, name: string, hostId: string): RoomDocument {
  const games = dataset.players.map(player => createGame(dataset, player.id));
  return { code, name, hostId, revision: 1, dataset, minute: 0, cells: games[0].cells,
    members: dataset.players.map(p => ({ id: p.id, name: p.name, team: p.team, color: teamColor(p.team), joined: p.id === hostId })),
    wallets: Object.fromEntries(games.map(({ cells: _cells, ...wallet }) => [wallet.playerId, { ...wallet, competitive: true }])) };
}
export function roomView(room: RoomDocument, playerId: string): RoomView {
  return { code: room.code, name: room.name, hostId: room.hostId, revision: room.revision, isHost: playerId === room.hostId,
    members: room.members, state: { ...room.wallets[playerId], cells: room.cells, minute: room.minute, competitive: true },
    dataset: { dates: room.dataset.dates, players: room.dataset.players.filter(p => p.id === playerId) } };
}
export function dispatchRoom(room: RoomDocument, playerId: string, command: Command): Omit<RoomReply, 'view'> {
  if (command.type === 'advance' && playerId !== room.hostId) return { code: 'HOST_ONLY', changed: [] };
  if (command.type === 'advance') {
    const results = room.members.map(p => dispatch(roomView(room, p.id).state, command, room.dataset));
    const failed = results.find(result => result.code !== 'OK');
    if (failed) return { code: failed.code, changed: [] };
    for (const result of results) {
      const { cells, ...wallet } = result.state;
      room.wallets[wallet.playerId] = wallet;
      room.cells = cells;
    }
    room.minute = command.toMinute;
    room.revision++;
    return { code: 'OK', changed: [] };
  }
  const result = dispatch(roomView(room, playerId).state, command, room.dataset);
  if (result.code === 'OK') {
    const { cells, ...wallet } = result.state;
    room.wallets[playerId] = wallet; room.cells = cells; room.revision++;
  }
  return { code: result.code, changed: result.changed };
}
