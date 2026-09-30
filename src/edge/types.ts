import type { DayResult } from '../game/standings';
import type { Cell, Dataset, GameState, Item } from '../game/types';
import type { RoomMember, RoomView } from '../rooms/types';

/** The 100 × 100 board is stored as 100 independent 10 × 10 tiles. */
export const TILE = 10;
export const TILES_PER_ROW = 10;
export const TILE_COUNT = TILES_PER_ROW * TILES_PER_ROW;

/** A cell as stored and published: `[owner team or null, shieldUntil minute]`. */
export type PackedCell = [string | null, number];

/** Immutable room definition, written once by an organizer. Contains private step histories. */
export interface RoomMeta {
  code: string; name: string; hostId: string;
  members: Omit<RoomMember, 'joined'>[];
  dataset: Dataset;
}
export interface TileRecord {
  cells: PackedCell[];
  /** Recent commands already applied here (`player:id`), with the paint they actually cost. */
  applied: { key: string; cost: number; cells: number[] }[];
}
/** Optional daily schedule: `at` is the minute of the UTC day, `next` the epoch milliseconds of the change that is due next. */
export interface AutoAdvance { at: number; next: number }
/** The shared clock. It carries the schedule, so every request that reads the clock also sees whether a day change is due. */
export interface ClockRecord { minute: number; id: string | null; auto?: AutoAdvance; /** How each closed day ended, oldest first. */ results?: DayResult[] }
export interface Receipt { id: string; payload: string; code: string; changed: number[]; message?: string }
export interface PendingCommand {
  id: string; payload: string;
  /** Paint reserved from the wallet before any tile changed. */
  charge: number; minute: number; team: string;
  tool: 'brush' | 'bomb' | 'shield';
  /** Board indices in the rules' order, grouped by tile in ascending tile order. */
  /** `budget`: what this tile's cells were reserved at, its own spending ceiling (absent in older records). */
  plan: { tile: number; cells: number[]; budget?: number }[];
}
export interface WalletRecord {
  spent: number; inventory: Record<Item, number>;
  messages: string[]; receipts: Receipt[];
  pending: PendingCommand | null;
}
/** Version numbers of the records a view was built from; clients merge by taking the newer one. */
export interface EdgeVersions { tiles: number[]; clock: number; wallet: number }
/** `live` says whether the server can push events (Fanout publishing is configured); without it browsers refresh by polling. */
export interface EdgeView extends RoomView { edge: EdgeVersions; live?: boolean; /** Signed ticket for live drawing previews (see ink-ticket.ts); absent when the server cannot push. */ ink?: string; /** Null while days are moved by hand (the default). */ autoAdvance?: AutoAdvance | null; /** How each closed day ended (who led when it closed). */ days?: DayResult[] }
export interface TileUpdate { tile: number; version: number; cells: PackedCell[] }
/** Private reply to a command: the caller's wallet plus the tiles it changed. */
export interface EdgeReply {
  code: string; changed: number[]; message?: string;
  wallet: { version: number; state: Omit<GameState, 'cells'> };
  tiles: TileUpdate[];
  clock: { version: number; minute: number; auto?: AutoAdvance | null; days?: DayResult[] };
}
/** Public events published to the room's Fanout channel. */
export type EdgeEvent =
  | ({ type: 'tile' } & TileUpdate)
  | { type: 'clock'; version: number; minute: number }
  | { type: 'roster'; playerId: string }
  /** A bomb or shield was used: where, by which team and under which command id, so every screen can play the right effect. */
  | { type: 'fx'; tool: 'bomb' | 'shield'; x: number; y: number; team: string; id: string }
  /** A live preview of what `from` is drawing: shown at once, replaced by the saved tiles, dropped if it never gets saved. */
  | { type: 'ink'; from: string; team: string; cells: number[] };

export const pack = (cell: Cell): PackedCell => [cell.owner, cell.shieldUntil];
export const unpack = ([owner, shieldUntil]: PackedCell): Cell => ({ owner, shieldUntil });
export const tileOf = (index: number) => Math.floor(Math.floor(index / 100) / TILE) * TILES_PER_ROW + Math.floor((index % 100) / TILE);
/** Board indices covered by a tile, in row-major order. */
export function tileCells(tile: number): number[] {
  const row = Math.floor(tile / TILES_PER_ROW) * TILE, col = (tile % TILES_PER_ROW) * TILE;
  return Array.from({ length: TILE * TILE }, (_, i) => (row + Math.floor(i / TILE)) * 100 + col + (i % TILE));
}
