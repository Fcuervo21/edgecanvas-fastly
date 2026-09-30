import type { Command, Dataset, GameState, Code } from '../game/types';

export interface RoomMember { id: string; name: string; team: string; color: string; joined: boolean }
export interface RoomView {
  code: string; name: string; revision: number; hostId: string; isHost: boolean;
  members: RoomMember[]; state: GameState; dataset: Dataset;
}
export interface RoomSession { code: string; token: string }
export interface RoomInvite { playerId: string; name: string; team: string; code: string }
export interface RoomEntry { session: RoomSession; view: RoomView; invites?: RoomInvite[] }
export interface RoomReply { view: RoomView; code: Code | 'HOST_ONLY'; changed: number[]; message?: string }
export interface RoomCommand { id: string; command: Command }
export interface RoomRoster { members: Omit<RoomMember, 'joined'>[]; maxTeamSize: number }
/** A committed public room change. It never carries balances, inventories, histories or credentials. */
export interface RoomEvent {
  revision: number;
  minute: number;
  cells: { index: number; owner: string | null; shieldUntil: number }[];
  rosterChanged: boolean;
}
/** Retained events after a revision, or a reset when the client must fetch a fresh private view. */
/** A visual effect announced by another player's move. */
export interface RoomEffect { tool: 'bomb' | 'shield'; x: number; y: number; team: string; id: string }
export type RoomReplay = { events: RoomEvent[] } | { reset: true; revision: number };
