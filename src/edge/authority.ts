import { creditedThrough, dispatch } from '../game/engine';
import { COST, SHIELD_MINUTES, SIZE } from '../game/rules';
import { dayResult, type DayResult } from '../game/standings';
import { BRUSH_MASKS, paintable } from '../game/targets';
import type { Command, Dataset, GameState } from '../game/types';
import { teamColor } from '../rooms/colors';
import { RoomError } from '../rooms/errors';
import type { RoomInvite, RoomMember } from '../rooms/types';
import { validateRoomCommand } from '../rooms/validate';
import { newestVersion, type EdgeKV } from './kv';
import {
  pack, tileCells, tileOf, TILE_COUNT, unpack,
  type AutoAdvance, type ClockRecord, type EdgeEvent, type EdgeReply, type EdgeView, type PackedCell, type PendingCommand,
  type Receipt, type RoomMeta, type TileRecord, type TileUpdate, type WalletRecord,
} from './types';

const DAY_MS = 86_400_000;
/** Most pixels one preview may carry. */
const INK_MAX = 400;
const RECEIPTS = 32, APPLIED = 64, MESSAGES = 20, ATTEMPTS = 12;
const fail = (status: number, message: string): never => { throw new RoomError(status, message); };
const emptyTile = (): TileRecord => ({ cells: Array.from({ length: 100 }, () => [null, 0] as PackedCell), applied: [] });
const emptyWallet = (): WalletRecord => ({ spent: 0, inventory: { bomb: 0, shield: 0 }, messages: [], receipts: [], pending: null });
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
async function digest(text: string) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
function secret() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(() => resolve(), ms));

export interface EdgeAuthorityOptions {
  kv: EdgeKV;
  /** Publishes a public event to the room's Fanout channel; failures are ignored (clients resync). */
  publish?: (room: string, event: EdgeEvent) => Promise<void>;
  /** Publishes several events in one call; preferred over `publish` so a big stroke costs one request. */
  publishBatch?: (room: string, events: EdgeEvent[]) => Promise<void>;
  /** Ends a player's held streams after logout. */
  closeStreams?: (room: string, playerId: string) => Promise<void>;
  /** Keeps best-effort background work alive after the response (Compute: `event.waitUntil`). */
  defer?: (work: Promise<unknown>) => void;
  /** Wall clock in epoch milliseconds; tests replace it to move days by schedule. */
  now?: () => number;
}

/**
 * Room authority for Fastly Compute backed only by KV Store. Every authoritative record is a
 * write-once versioned key created with insert-if-absent, so concurrent writers serialize on the
 * version number: the loser sees its insert refused and retries on the newer version.
 *
 * - Wallet (per player): spend, inventory, receipts. Only that player's requests write it.
 * - Tiles (100 × 10 × 10 cells): ownership and shields. Writers conflict only on the same tile.
 * - Clock: the shared simulated minute; only the host advances it. Credits and shield expiry are
 *   derived from it, so advancing time never rewrites wallets.
 *
 * A paint command reserves its full price in a new wallet version (with a pending plan), applies
 * the plan tile by tile (each tile records the command so re-application is a no-op), then writes
 * a final wallet version that refunds anything a racing player made unpaintable. Money is never
 * created: cells are only painted after their price is reserved, and a crashed request is resumed
 * by the player's next request.
 */
export function createEdgeAuthority(options: EdgeAuthorityOptions) {
  const { kv } = options;
  const metaCache = new Map<string, RoomMeta>();
  const key = {
    meta: (room: string) => `r/${room}/meta`,
    heads: (room: string) => `r/${room}/heads`,
    clock: (room: string, n: number) => `r/${room}/c/${n}`,
    tile: (room: string, tile: number, n: number) => `r/${room}/t/${tile}/${n}`,
    wallet: (room: string, player: string, n: number) => `r/${room}/w/${encodeURIComponent(player)}/${n}`,
    walletHint: (room: string, player: string) => `r/${room}/wh/${encodeURIComponent(player)}`,
    // Listable key families avoid "/" and ":", which the real KV Store refuses in listing prefixes.
    joined: (room: string, player?: string) => `joined-${room}-${player === undefined ? '' : encodeURIComponent(player)}`,
    roomIndex: (room?: string) => `rooms-${room ?? ''}`,
    invite: (room: string, hash: string) => `r/${room}/inv/${hash}`,
    session: (room: string, hash: string) => `r/${room}/s/${hash}`,
  };
  const now = () => options.now?.() ?? Date.now();
  const background = (work: Promise<unknown>) => { const safe = work.catch(() => {}); options.defer?.(safe); };
  async function json<T>(k: string): Promise<T | null> { const text = await kv.get(k); return text === null ? null : JSON.parse(text) as T; }
  /** Reads a key that is known to exist, tolerating an eventually consistent miss. */
  async function existing<T>(k: string): Promise<T> {
    for (let i = 0; i < 6; i++) { const value = await json<T>(k); if (value !== null) return value; await wait(25 * 2 ** i); }
    return fail(503, 'The room is busy. Please retry.');
  }
  const newest = (at: (n: number) => string, hint = 0) => newestVersion(kv, at, hint);
  async function meta(room: string): Promise<RoomMeta> {
    const cached = metaCache.get(room); if (cached) return cached;
    const value = await json<RoomMeta>(key.meta(room));
    if (!value) return fail(404, 'Room not found.');
    metaCache.set(room, value); return value;
  }
  async function heads(room: string) { return (await json<{ tiles: number[]; clock: number }>(key.heads(room))) ?? { tiles: Array(TILE_COUNT).fill(0), clock: 0 }; }
  /** Best-effort hint so fresh readers skip old versions. Losing a hint only costs extra reads. */
  function hint(room: string, update: (h: { tiles: number[]; clock: number }) => void) {
    background((async () => { const h = await heads(room); update(h); await kv.put(key.heads(room), JSON.stringify(h)); })());
  }
  async function readTile(room: string, tile: number, from = 0): Promise<{ version: number; record: TileRecord }> {
    const version = await newest(n => key.tile(room, tile, n), from);
    return { version, record: version ? await existing<TileRecord>(key.tile(room, tile, version)) : emptyTile() };
  }
  async function readClock(room: string, from = 0): Promise<{ version: number; record: ClockRecord }> {
    const version = await newest(n => key.clock(room, n), from);
    return { version, record: version ? await existing<ClockRecord>(key.clock(room, version)) : { minute: 0, id: null } };
  }
  /**
   * Applies a scheduled day change that has come due. It is done by whichever request notices first: clock versions are
   * write-once, so simultaneous requests race for one version and the losers just read the winner's. Days missed while
   * nobody was looking are caught up together (paint accumulates, so nothing is lost), never past the last recorded day.
   */
  async function settled(room: string, m: RoomMeta, clock: { version: number; record: ClockRecord }): Promise<{ version: number; record: ClockRecord }> {
    const last = m.dataset.dates.length - 1;
    for (let i = 0; i < 4; i++) {
      const auto = clock.record.auto, day = Math.floor(clock.record.minute / 1440), at = now();
      if (!auto || at < auto.next || day >= last) return clock;
      const passed = Math.floor((at - auto.next) / DAY_MS) + 1;
      const minute = Math.min(day + passed, last) * 1440;
      const record: ClockRecord = { minute, id: `auto-${auto.next}`, auto: { at: auto.at, next: auto.next + passed * DAY_MS }, results: await closing(room, clock.record, minute) };
      const version = clock.version + 1;
      if (await kv.add(key.clock(room, version), JSON.stringify(record))) {
        hint(room, h => { h.clock = Math.max(h.clock, version); });
        await publish(room, { type: 'clock', version, minute: record.minute });
        return { version, record };
      }
      clock = await readClock(room, version);
    }
    return clock;
  }
  /** The results so far plus one for every day that closes when the clock moves to `toMinute`, judged on the board as it is now. */
  async function closing(room: string, record: ClockRecord, toMinute: number): Promise<DayResult[]> {
    const before = record.results ?? [], from = Math.floor(record.minute / 1440), to = Math.floor(toMinute / 1440);
    if (to <= from) return before;
    const h = await heads(room);
    const tiles = await Promise.all(Array.from({ length: TILE_COUNT }, (_, tile) => readTile(room, tile, h.tiles[tile] ?? 0)));
    const cells = tiles.flatMap(({ record: tile }) => tile.cells.map(cell => unpack(cell)));
    return [...before, ...Array.from({ length: to - from }, (_, i) => dayResult(from + i, cells))];
  }
  async function readWallet(room: string, player: string, from = 0): Promise<{ version: number; record: WalletRecord }> {
    const saved = Number(await kv.get(key.walletHint(room, player)) ?? 0);
    const version = await newest(n => key.wallet(room, player, n), Math.max(from, Number.isSafeInteger(saved) ? saved : 0));
    return { version, record: version ? await existing<WalletRecord>(key.wallet(room, player, version)) : emptyWallet() };
  }
  async function writeWallet(room: string, player: string, version: number, record: WalletRecord) {
    const ok = await kv.add(key.wallet(room, player, version), JSON.stringify(record));
    if (ok) background(kv.put(key.walletHint(room, player), String(version)));
    return ok;
  }
  async function publishAll(room: string, events: EdgeEvent[]) {
    if (!events.length) return;
    try {
      if (options.publishBatch) await options.publishBatch(room, events);
      else for (const event of events) await options.publish?.(room, event);
    } catch { /* clients resync */ }
  }
  const publish = (room: string, event: EdgeEvent) => publishAll(room, [event]);

  async function authenticate(room: string, token: unknown): Promise<string> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) return fail(401, 'A valid room session is required.');
    const k = key.session(room, await digest(token));
    // A just-created session may not be visible everywhere yet, so retry briefly before refusing.
    for (let i = 0; i < 4; i++) {
      const session = await json<{ player: string }>(k);
      if (session) return session.player;
      if (i < 3) await wait(25 * 2 ** i);
    }
    return fail(401, 'A valid room session is required.');
  }
  function state(m: RoomMeta, player: string, wallet: WalletRecord, minute: number, cells: GameState['cells']): GameState {
    const member = m.dataset.players.find(p => p.id === player)!;
    const day = Math.floor(minute / 1440), earned = creditedThrough(m.dataset, member, day);
    return { version: 1, competitive: true, playerId: player, team: member.team, cells, minute, lastCreditedDay: day,
      earned, spent: wallet.spent, balance: earned - wallet.spent, inventory: { ...wallet.inventory }, messages: wallet.messages.slice() };
  }
  function walletState(m: RoomMeta, player: string, wallet: WalletRecord, minute: number) {
    const { cells: _cells, ...rest } = state(m, player, wallet, minute, []);
    return rest;
  }
  /** Tiles a command can read or change: its points, or the stamp/bomb/shield box around it. */
  function tilesFor(command: Command): number[] {
    const tiles = new Set<number>();
    const add = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) tiles.add(tileOf(y * SIZE + x)); };
    if (command.type === 'stroke') for (const p of command.points) add(p.x, p.y);
    if (command.type === 'apply') {
      const radius = command.tool === 'bomb' ? 2 : command.tool === 'shield' ? 1 : Math.floor(BRUSH_MASKS[command.shape ?? 'pixel'].length / 2);
      for (let y = command.y - radius; y <= command.y + radius; y++) for (let x = command.x - radius; x <= command.x + radius; x++) add(x, y);
    }
    return [...tiles].sort((a, b) => a - b);
  }

  /** Applies one tile of a pending plan exactly once; returns the paint it actually cost. */
  async function applyTile(room: string, player: string, pending: PendingCommand, tile: number, budget: number, startVersion = 0): Promise<{ cost: number; update?: TileUpdate; cells: number[] }> {
    const mark = `${player}:${pending.id}`;
    const cells = pending.plan.find(p => p.tile === tile)!.cells;
    let from = startVersion;
    for (let attempt = 0; attempt < ATTEMPTS * 4; attempt++) {
      const { version, record } = await readTile(room, tile, from);
      const done = record.applied.find(a => a.key === mark);
      if (done) return { cost: done.cost, cells: done.cells };
      const board: GameState['cells'] = Array(SIZE * SIZE);
      for (const [i, index] of tileCells(tile).entries()) board[index] = unpack(record.cells[i]);
      const view = { cells: board, minute: pending.minute, team: pending.team, competitive: true } as GameState;
      const next = record.cells.slice(); let cost = 0; const changed: number[] = [];
      for (const index of cells) {
        const local = tileCells(tile).indexOf(index), cell = board[index];
        if (pending.tool === 'shield') {
          if (cell.owner !== pending.team) continue;
          next[local] = [cell.owner, pending.minute + SHIELD_MINUTES];
        } else {
          if (!paintable(view, index)) continue;
          const price = pending.tool === 'brush' ? (cell.owner === null ? COST.brush : COST.rival) : 0;
          if (cost + price > budget) continue;
          cost += price; next[local] = [pending.team, 0];
        }
        changed.push(index);
      }
      const written: TileRecord = { cells: next, applied: [...record.applied, { key: mark, cost, cells: changed }].slice(-APPLIED) };
      if (await kv.add(key.tile(room, tile, version + 1), JSON.stringify(written))) {
        const update = { tile, version: version + 1, cells: next };
        hint(room, h => { h.tiles[tile] = Math.max(h.tiles[tile] ?? 0, version + 1); });
        return { cost, update, cells: changed };
      }
      from = version + 1;
      await wait(Math.random() * 20 * Math.min(attempt + 1, 5));
    }
    return fail(503, 'The canvas is busy here. Please retry.');
  }
  /** Finishes a reserved command: applies every tile, then refunds the unused reservation. */
  async function complete(room: string, player: string, m: RoomMeta, walletVersion: number, wallet: WalletRecord): Promise<{ version: number; wallet: WalletRecord; tiles: TileUpdate[]; receipt: Receipt }> {
    const pending = wallet.pending!;
    let spentOnTiles = 0; const tiles: TileUpdate[] = []; const changed: number[] = [];
    // One read of the version hints for the whole command (each remote lookup costs ~160 ms on the real KV Store).
    const known = (await heads(room)).tiles;
    // Each tile gets the price its own cells were reserved at, so tiles are independent and can be saved in parallel
    // without ever spending more than was reserved. Anything else (an older record) falls back to one tile at a time.
    const budgets = pending.plan.map(step => step.budget);
    const independent = budgets.every(b => b !== undefined) && budgets.reduce((sum, b) => sum + b!, 0) <= pending.charge;
    const results: Awaited<ReturnType<typeof applyTile>>[] = [];
    if (independent) results.push(...await Promise.all(pending.plan.map(step => applyTile(room, player, pending, step.tile, step.budget!, known[step.tile] ?? 0))));
    else { let budget = pending.charge; for (const { tile } of pending.plan) { const result = await applyTile(room, player, pending, tile, budget, known[tile] ?? 0); budget -= result.cost; results.push(result); } }
    for (const result of results) { spentOnTiles += result.cost; changed.push(...result.cells); if (result.update) tiles.push(result.update); }
    // One publish request per command, however many tiles it changed. A bomb or shield announces where it landed first,
    // so every screen can play the effect at the right place while the pixels appear.
    const events: EdgeEvent[] = [];
    if (pending.tool === 'bomb' || pending.tool === 'shield') {
      const { x, y } = JSON.parse(pending.payload) as { x: number; y: number };
      events.push({ type: 'fx', tool: pending.tool, x, y, team: pending.team, id: pending.id });
    }
    await publishAll(room, [...events, ...tiles.map(update => ({ type: 'tile' as const, ...update }))]);
    const refund = pending.tool === 'brush' ? pending.charge - spentOnTiles : 0;
    const code = changed.length ? 'OK' : 'NO_CHANGE';
    const receipt: Receipt = { id: pending.id, payload: pending.payload, code, changed };
    const finished: WalletRecord = { ...wallet, spent: wallet.spent - refund, pending: null, receipts: [...wallet.receipts, receipt].slice(-RECEIPTS) };
    // The tiles are saved and the paint reserved, so the answer is already known: it goes out now and the closing wallet
    // record (which only clears the pending plan and refunds any unused reservation) is written right after. If that write
    // is lost or another request of this player closes it first, the next request finds the plan and finishes it exactly once.
    background(writeWallet(room, player, walletVersion + 1, finished));
    return { version: walletVersion + 1, wallet: finished, tiles, receipt };
  }

  async function reply(room: string, m: RoomMeta, player: string, version: number, wallet: WalletRecord, receipt: Receipt, tiles: TileUpdate[], clockFrom = 0, known?: { version: number; record: ClockRecord }): Promise<EdgeReply> {
    const clock = known ?? await readClock(room, clockFrom);
    return { code: receipt.code, changed: receipt.changed, ...(receipt.message ? { message: receipt.message } : {}),
      wallet: { version, state: walletState(m, player, wallet, clock.record.minute) }, tiles, clock: { version: clock.version, minute: clock.record.minute, auto: clock.record.auto ?? null, days: clock.record.results ?? [] } };
  }

  async function command(room: string, token: unknown, input: unknown, hints: { wallet?: number; clock?: number } = {}): Promise<EdgeReply> {
    const request = validateRoomCommand(input);
    return commandAs(room, await authenticate(room, token), request, hints);
  }
  /** Runs a command for a player the caller has already authenticated and checked for membership. */
  /**
   * `gate` (the player's rate limit) runs alongside the reads: nothing is written until it has passed, and a refused
   * move throws before it can change anything.
   */
  async function commandAs(room: string, player: string, input: unknown, hints: { wallet?: number; clock?: number } = {}, gate?: Promise<unknown>): Promise<EdgeReply> {
    const request = validateRoomCommand(input);
    const payload = JSON.stringify(request.command);
    const m = await meta(room);
    if (!m.members.some(member => member.id === player)) return fail(403, 'You are not a member of this room.');
    let walletFrom = hints.wallet ?? 0, clockFrom = hints.clock ?? 0;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      // Wallet, clock and version hints are independent lookups: fetch them together (a retry or resume ignores the extras).
      // The version hints come first (a fast hit), so the clock is found from its recent version instead of from 1.
      const h = await heads(room);
      const [{ version, record: wallet }, current] = await Promise.all([readWallet(room, player, walletFrom), readClock(room, Math.max(clockFrom, h.clock))]);
      const clock = await settled(room, m, current);
      const saved = wallet.receipts.find(r => r.id === request.id);
      if (saved) {
        if (saved.payload !== payload) return fail(409, 'This request ID was already used for a different command.');
        return reply(room, m, player, version, wallet, saved, [], clockFrom);
      }
      if (wallet.pending) {
        if (wallet.pending.id === request.id && wallet.pending.payload !== payload) return fail(409, 'This request ID was already used for a different command.');
        // Resume an interrupted command (this one after a lost acknowledgment, or an earlier one).
        const done = await complete(room, player, m, version, wallet);
        if (done.receipt.id === request.id) return reply(room, m, player, done.version, done.wallet, done.receipt, done.tiles, clockFrom);
        walletFrom = done.version; continue;
      }
      const command = request.command;
      if (command.type === 'advance') {
        if (player !== m.hostId) return reply(room, m, player, version, wallet, { id: request.id, payload, code: 'HOST_ONLY', changed: [] }, [], clock.version);
        if (clock.record.id === request.id) return reply(room, m, player, version, wallet, { id: request.id, payload, code: 'OK', changed: [] }, [], clock.version);
        if (!Number.isSafeInteger(command.toMinute) || command.toMinute < clock.record.minute) return reply(room, m, player, version, wallet, { id: request.id, payload, code: 'INVALID_TIME', changed: [] }, [], clock.version);
        if (command.toMinute === clock.record.minute) return reply(room, m, player, version, wallet, { id: request.id, payload, code: 'NO_CHANGE', changed: [] }, [], clock.version);
        // Rooms end with the data: never invent steps for days that were not recorded.
        if (Math.floor(command.toMinute / 1440) >= m.dataset.dates.length) return reply(room, m, player, version, wallet, { id: request.id, payload, code: 'NO_MORE_DAYS', changed: [] }, [], clock.version);
        const earned = creditedThrough(m.dataset, m.dataset.players[0], Math.floor(command.toMinute / 1440));
        if (!Number.isSafeInteger(earned)) return reply(room, m, player, version, wallet, { id: request.id, payload, code: 'INVALID_TIME', changed: [] }, [], clock.version);
        const results = await closing(room, clock.record, command.toMinute);
        await gate;
        if (!(await kv.add(key.clock(room, clock.version + 1), JSON.stringify({ minute: command.toMinute, id: request.id, ...(clock.record.auto ? { auto: clock.record.auto } : {}), results } satisfies ClockRecord)))) { clockFrom = clock.version + 1; continue; }
        hint(room, h => { h.clock = Math.max(h.clock, clock.version + 1); });
        await publish(room, { type: 'clock', version: clock.version + 1, minute: command.toMinute });
        return reply(room, m, player, version, wallet, { id: request.id, payload, code: 'OK', changed: [] }, [], clock.version + 1);
      }
      const tiles = command.type === 'buy' ? [] : tilesFor(command);
      const read = await Promise.all(tiles.map(tile => readTile(room, tile, h.tiles[tile] ?? 0)));
      const board: GameState['cells'] = Array.from({ length: SIZE * SIZE }, () => ({ owner: null, shieldUntil: 0 }));
      tiles.forEach((tile, i) => tileCells(tile).forEach((index, j) => { board[index] = unpack(read[i].record.cells[j]); }));
      const before = state(m, player, wallet, clock.record.minute, board);
      const result = dispatch(before, command, m.dataset);
      if (result.code !== 'OK') {
        // Rejections change nothing and are not stored; a retry is simply evaluated again.
        return reply(room, m, player, version, wallet, { id: request.id, payload, code: result.code, changed: [] }, [], clock.version, clock);
      }
      const charge = result.state.spent - before.spent;
      const next: WalletRecord = { ...wallet, spent: result.state.spent, inventory: result.state.inventory, messages: result.state.messages.slice(0, MESSAGES) };
      if (command.type === 'buy') {
        const receipt: Receipt = { id: request.id, payload, code: 'OK', changed: [] };
        next.receipts = [...wallet.receipts, receipt].slice(-RECEIPTS);
        await gate;
        if (!(await writeWallet(room, player, version + 1, next))) { walletFrom = version + 1; continue; }
        return reply(room, m, player, version + 1, next, receipt, [], clock.version, clock);
      }
      // The reserved price of each tile's cells (empty or rival), the ceiling that tile may spend later.
      const cellPrice = (index: number) => command.type === 'stroke' || command.tool === 'brush' ? (board[index].owner === null ? COST.brush : COST.rival) : 0;
      const plan = tiles.map(tile => ({ tile, cells: result.changed.filter(index => tileOf(index) === tile) })).filter(p => p.cells.length)
        .map(step => ({ ...step, budget: step.cells.reduce((sum, index) => sum + cellPrice(index), 0) }));
      next.pending = { id: request.id, payload, charge, minute: clock.record.minute, team: before.team,
        tool: command.type === 'stroke' ? 'brush' : command.tool, plan };
      await gate;
      if (!(await writeWallet(room, player, version + 1, next))) { walletFrom = version + 1; continue; }
      const done = await complete(room, player, m, version + 1, next);
      return reply(room, m, player, done.version, done.wallet, done.receipt, done.tiles, clock.version, clock);
    }
    return fail(503, 'The room is busy. Please retry.');
  }

  async function view(room: string, token: unknown): Promise<EdgeView> { return viewAs(room, await authenticate(room, token)); }
  async function viewAs(room: string, player: string): Promise<EdgeView> {
    const m = await meta(room);
    if (!m.members.some(member => member.id === player)) return fail(403, 'You are not a member of this room.');
    const h = await heads(room);
    const [tiles, clock, wallet, joined] = await Promise.all([
      Promise.all(Array.from({ length: TILE_COUNT }, (_, tile) => readTile(room, tile, h.tiles[tile] ?? 0))),
      readClock(room, h.clock).then(current => settled(room, m, current)), readWallet(room, player), kv.list(key.joined(room)),
    ]);
    const cells: GameState['cells'] = Array(SIZE * SIZE);
    tiles.forEach(({ record }, tile) => tileCells(tile).forEach((index, i) => { cells[index] = unpack(record.cells[i]); }));
    const joinedIds = new Set(joined.map(k => decodeURIComponent(k.slice(key.joined(room).length))));
    const members: RoomMember[] = m.members.map(member => ({ ...member, joined: joinedIds.has(member.id) }));
    const versions = { tiles: tiles.map(t => t.version), clock: clock.version, wallet: wallet.version };
    return { code: m.code, name: m.name, hostId: m.hostId, isHost: player === m.hostId, members,
      revision: versions.tiles.reduce((a, b) => a + b, 0) + versions.clock + versions.wallet + joinedIds.size,
      state: state(m, player, wallet.record, clock.record.minute, cells),
      dataset: { dates: m.dataset.dates, players: m.dataset.players.filter(p => p.id === player) }, edge: versions, autoAdvance: clock.record.auto ?? null, days: clock.record.results ?? [] };
  }

  /**
   * Host only. `at` is a minute of the UTC day (the browser converts from the host's local time); `null` returns to
   * moving days by hand. The first change is the next time that minute comes round, never earlier today's past.
   */
  async function setSchedule(room: string, player: string, input: { at: number | null }): Promise<EdgeView> {
    const m = await meta(room);
    if (player !== m.hostId) return fail(403, 'Only the host can schedule day changes.');
    const at = input?.at;
    if (at !== null && !(typeof at === 'number' && Number.isInteger(at) && at >= 0 && at < 1440)) return fail(400, 'Choose a time of day.');
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const clock = await settled(room, m, await readClock(room, (await heads(room)).clock));
      let auto: AutoAdvance | undefined;
      if (at !== null) {
        const t = now(), today = t - (t % DAY_MS) + at * 60_000;
        auto = { at, next: today > t ? today : today + DAY_MS };
      }
      const version = clock.version + 1;
      const record: ClockRecord = { minute: clock.record.minute, id: `schedule-${secret()}`, ...(auto ? { auto } : {}), ...(clock.record.results ? { results: clock.record.results } : {}) };
      if (!(await kv.add(key.clock(room, version), JSON.stringify(record)))) continue;
      hint(room, h => { h.clock = Math.max(h.clock, version); });
      await publish(room, { type: 'clock', version, minute: record.minute });
      return viewAs(room, player);
    }
    return fail(503, 'The room is busy. Please retry.');
  }

  /**
   * Publishes a live preview of the pixels a player is drawing, without reading or writing storage: the slow,
   * authoritative save follows on its own. Purely visual, so nothing here is charged. The caller has already proved who
   * the player is and which team they are on (a signed ticket issued with their room view); `gate` (the rate limit) must
   * pass before anything is published.
   */
  async function ink(room: string, from: { player: string; team: string }, input: { cells?: unknown }, gate?: Promise<unknown>): Promise<void> {
    const cells = input?.cells;
    if (!Array.isArray(cells) || !cells.length || cells.length > INK_MAX || !cells.every(i => Number.isInteger(i) && i >= 0 && i < SIZE * SIZE)) return fail(400, 'Send the pixels you are drawing.');
    await gate;
    await publish(room, { type: 'ink', from: from.player, team: from.team, cells: [...new Set(cells as number[])] });
  }

  /** Marks a member as joined (announcing it once) and returns their view. */
  async function enter(room: string, player: string): Promise<EdgeView> {
    const m = await meta(room);
    if (!m.members.some(member => member.id === player)) return fail(403, 'You are not a member of this room.');
    if (await kv.add(key.joined(room, player), '1')) await publish(room, { type: 'roster', playerId: player });
    return viewAs(room, player);
  }

  return {
    command, view, commandAs, viewAs, enter, setSchedule, ink,
    /** Throws 404/403 unless the room exists and lists this player. */
    async member(room: string, player: string) {
      if (!(await meta(room)).members.some(member => member.id === player)) fail(403, 'You are not a member of this room.');
    },
    /** Takes every room except `keep` off the room lists (their records stay in KV, unused). Returns how many were retired. */
    async retireRoomsExcept(keep: string): Promise<number> {
      const stale = (await kv.list(key.roomIndex())).filter(k => k.slice(key.roomIndex().length) !== keep);
      await Promise.all(stale.map(k => kv.delete(k)));
      return stale.length;
    },
    /** Rooms whose roster includes this player, newest first. */
    async rooms(player: string): Promise<{ code: string; name: string }[]> {
      const codes = (await kv.list(key.roomIndex())).map(k => k.slice(key.roomIndex().length));
      const rooms = await Promise.all(codes.map(code => meta(code).catch(() => null)));
      return rooms.filter((m): m is RoomMeta => !!m && m.members.some(member => member.id === player)).map(m => ({ code: m.code, name: m.name }));
    },
    /** Organizer-only (the HTTP layer checks the admin secret). Stores the roster privately in KV. */
    /** `invites: false` (hosted accounts) skips the per-player invite records: they are never used and each write costs ~200 ms. */
    async createRoom(input: { name: string; hostId: string; dataset: Dataset }, settings: { invites?: boolean } = {}): Promise<{ code: string; invites: RoomInvite[] }> {
      const { name, hostId, dataset } = input;
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || !dataset?.players?.some(p => p.id === hostId) || !dataset.dates?.length) return fail(400, 'Choose a room name, roster and host.');
      const counts = new Map<string, number>();
      for (const p of dataset.players) { counts.set(p.team, (counts.get(p.team) ?? 0) + 1); if (counts.get(p.team)! > 3) return fail(400, 'Teams may contain at most three players.'); }
      const code = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      const record: RoomMeta = { code, name: name.trim(), hostId, dataset,
        members: dataset.players.map(p => ({ id: p.id, name: p.name, team: p.team, color: teamColor(p.team) })) };
      if (!(await kv.add(key.meta(code), JSON.stringify(record)))) return fail(503, 'Please retry.');
      await kv.add(key.roomIndex(code), name.trim());
      const invites: RoomInvite[] = [];
      for (const p of settings.invites === false ? [] : dataset.players) {
        const invite = secret();
        await kv.add(key.invite(code, await digest(invite)), JSON.stringify({ player: p.id }));
        invites.push({ playerId: p.id, name: p.name, team: p.team, code: invite });
      }
      return { code, invites };
    },
    async join(room: string, input: unknown): Promise<{ session: { code: string; token: string }; view: EdgeView }> {
      const invite = (input as { inviteCode?: unknown })?.inviteCode;
      if (typeof invite !== 'string' || invite.length > 128 || !invite) return fail(400, 'A personal invite code is required.');
      await meta(room);
      const row = await json<{ player: string }>(key.invite(room, await digest(invite)));
      if (!row) return fail(403, 'Invalid personal invite code.');
      const token = secret();
      await kv.add(key.session(room, await digest(token)), JSON.stringify({ player: row.player }));
      if (await kv.add(key.joined(room, row.player), '1')) await publish(room, { type: 'roster', playerId: row.player });
      for (let i = 0; i < 6; i++) { try { return { session: { code: room, token }, view: await view(room, token) }; } catch (error) { if ((error as RoomError).status !== 401) throw error; await wait(25 * 2 ** i); } }
      return fail(503, 'Please retry.');
    },
    async logout(room: string, token: unknown) {
      if (typeof token !== 'string' || !token) return fail(401, 'A valid room session is required.');
      const k = key.session(room, await digest(token));
      const session = await json<{ player: string }>(k);
      await kv.delete(k);
      if (session) await options.closeStreams?.(room, session.player).catch(() => {});
    },
    /** Authorizes a stream subscription; returns the player for channel naming. */
    authorize: (room: string, token: unknown) => authenticate(room, token),
  };
}
export type EdgeAuthority = ReturnType<typeof createEdgeAuthority>;
