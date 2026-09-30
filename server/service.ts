import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Command, Dataset } from '../src/game/types';
import { SIZE } from '../src/game/rules';
import { teamColor } from '../src/rooms/colors';
import { createRoomDocument, dispatchRoom, roomView, type RoomDocument } from '../src/rooms/engine';
import type { RoomCommand, RoomEntry, RoomEvent, RoomInvite, RoomReplay, RoomReply, RoomRoster, RoomView } from '../src/rooms/types';

import { RoomError } from './errors';
import { validateRoomCommand } from '../src/rooms/validate';
import { createAccountAuth } from './auth';
export { RoomError } from './errors';
const fail = (status: number, message: string): never => { throw new RoomError(status, message); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(k => allowed.includes(k));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const secret = () => randomBytes(24).toString('base64url');
/** Public events kept per room for reconnect replay. Older clients receive a reset and fetch a snapshot. */
export const EVENT_RETENTION = 256;
export type RoomPublisher = (room: string, event: RoomEvent) => Promise<void>;

export { validateRoomCommand };

export function createRoomService(options: { dataset: Dataset; databasePath?: string; accessMode?: 'local' | 'accounts'; now?: () => number; publish?: RoomPublisher;
  /** Best-effort: ends a player's externally held streams (Fanout) after their sessions are revoked. */
  closeStreams?: (playerId: string) => Promise<void> }) {
  const dataset = structuredClone(options.dataset);
  const counts = new Map<string, number>();
  for (const p of dataset.players) {
    const count = (counts.get(p.team) ?? 0) + 1; counts.set(p.team, count);
    if (count > 3) fail(400, 'Teams may contain at most three players.');
  }
  if (!dataset.players.length || !dataset.dates.length || new Set(dataset.players.map(p => p.id)).size !== dataset.players.length) fail(400, 'Invalid roster.');
  const path = options.databasePath ?? (options.accessMode === 'accounts' ? '.local/accounts-rooms.sqlite' : '.local/rooms.sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invites (room TEXT NOT NULL, player TEXT NOT NULL, code TEXT NOT NULL UNIQUE, PRIMARY KEY(room, player));
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, room TEXT NOT NULL, player TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS receipts (room TEXT NOT NULL, player TEXT NOT NULL, request TEXT NOT NULL, payload TEXT NOT NULL, reply TEXT NOT NULL, PRIMARY KEY(room, player, request));
    CREATE TABLE IF NOT EXISTS events (room TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(room, revision));
    CREATE TABLE IF NOT EXISTS outbox (room TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(room, revision));`);
  const mode = options.accessMode ?? 'local';
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const savedMode = db.prepare("SELECT value FROM settings WHERE key = 'access_mode'").get();
  const legacy = !savedMode && Number(db.prepare('SELECT COUNT(*) AS n FROM rooms').get()!.n) > 0;
  if ((savedMode && savedMode.value !== mode) || (legacy && mode !== 'local')) {
    db.close(); throw new Error('Use a separate database for account mode.');
  }
  db.prepare("INSERT OR IGNORE INTO settings VALUES ('access_mode', ?)").run(mode);
  const auth = mode === 'accounts' ? createAccountAuth({ db, playerIds: dataset.players.map(p => p.id), now: options.now, onRevoke: revoked }) : undefined;
  function localOnly() { if (auth) fail(403, 'Local demo access is disabled in account mode.'); }
  let closed = false;
  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    let result: T;
    try { result = fn(); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); committed.clear(); throw error; }
    notify();
    return result;
  }
  function read(code: string): RoomDocument {
    const row = db.prepare('SELECT document FROM rooms WHERE code = ?').get(code);
    if (!row) fail(404, 'Room not found.');
    return JSON.parse(row!.document as string) as RoomDocument;
  }
  const watchers = new Map<string, Set<() => void>>();
  const committed = new Set<string>();
  type Snapshot = Pick<RoomDocument, 'revision' | 'cells' | 'members'>;
  const snapshot = (room: RoomDocument): Snapshot => ({ revision: room.revision, cells: room.cells.map(cell => ({ ...cell })), members: room.members.map(member => ({ ...member })) });
  function save(room: RoomDocument, before: Snapshot) {
    db.prepare('UPDATE rooms SET document = ? WHERE code = ?').run(JSON.stringify(room), room.code);
    if (room.revision === before.revision) return;
    // The event, outbox row, state and receipt share one transaction, so a published revision is always committed.
    const event: RoomEvent = { revision: room.revision, minute: room.minute,
      cells: room.cells.flatMap((cell, index) => cell.owner === before.cells[index].owner && cell.shieldUntil === before.cells[index].shieldUntil
        ? [] : [{ index, owner: cell.owner, shieldUntil: cell.shieldUntil }]),
      rosterChanged: room.members.some((member, index) => member.joined !== before.members[index].joined) };
    db.prepare('INSERT INTO events VALUES (?, ?, ?)').run(room.code, event.revision, JSON.stringify(event));
    db.prepare('DELETE FROM events WHERE room = ? AND revision <= ?').run(room.code, event.revision - EVENT_RETENTION);
    if (options.publish) db.prepare('INSERT INTO outbox VALUES (?, ?)').run(room.code, event.revision);
    committed.add(room.code);
  }
  function replay(code: string, after: number): RoomReplay {
    const revision = read(code).revision;
    if (!Number.isSafeInteger(after) || after < 0) return fail(400, 'Invalid revision.');
    if (after >= revision) return { events: [] };
    const events = db.prepare('SELECT body FROM events WHERE room = ? AND revision > ? ORDER BY revision').all(code, after)
      .map(row => JSON.parse(row.body as string) as RoomEvent);
    return events[0]?.revision === after + 1 ? { events } : { reset: true, revision };
  }
  let flushing: Promise<void> | undefined, flushAgain = false;
  function flushOutbox(): Promise<void> {
    const publish = options.publish;
    if (!publish) return Promise.resolve();
    // One drain at a time keeps each room's publications in revision order.
    if (flushing) { flushAgain = true; return flushing; }
    const drain = async () => {
      await Promise.resolve();
      if (closed) { flushing = undefined; return; }
      try {
        const blocked = new Set<string>();
        for (const row of db.prepare('SELECT o.room, o.revision, e.body FROM outbox o LEFT JOIN events e ON e.room = o.room AND e.revision = o.revision ORDER BY o.room, o.revision').all()) {
          if (closed) return;
          const room = row.room as string, revision = row.revision as number;
          if (blocked.has(room)) continue;
          if (row.body !== null) {
            // Stop this room at the first failure so a later revision is never published before an earlier one.
            try { await publish(room, JSON.parse(row.body as string) as RoomEvent); }
            catch { blocked.add(room); continue; }
          }
          if (!closed) db.prepare('DELETE FROM outbox WHERE room = ? AND revision = ?').run(room, revision);
        }
      } finally {
        flushing = undefined;
        // Rows committed during this drain are published by a follow-up drain.
        if (flushAgain && !closed) { flushAgain = false; void flushOutbox(); }
      }
    };
    return flushing = drain();
  }
  function revoked(playerId: string) {
    // Local streams re-check access immediately; held Fanout streams are closed and must reconnect.
    for (const set of watchers.values()) for (const listener of [...set]) { try { listener(); } catch { /* Ignore a broken subscriber. */ } }
    options.closeStreams?.(playerId).catch(() => options.closeStreams?.(playerId).catch(() => {}));
  }
  function notify() {
    for (const code of [...committed]) {
      committed.delete(code);
      for (const listener of watchers.get(code) ?? []) { try { listener(); } catch { /* A broken subscriber cannot affect a committed command. */ } }
    }
    void flushOutbox();
  }
  function authenticate(code: string, token: string): string {
    if (typeof token !== 'string' || !token || token.length > 256) return fail(401, 'A valid room session is required.');
    const row = db.prepare('SELECT player FROM sessions WHERE token = ? AND room = ?').get(hash(token), code);
    if (!row) return fail(401, 'A valid room session is required.');
    return row.player as string;
  }
  function session(code: string, player: string) {
    const token = secret(); db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), code, player);
    return { code, token };
  }
  function roomInvites(room: RoomDocument): RoomInvite[] {
    return room.members.map(member => ({ playerId: member.id, name: member.name, team: member.team,
      code: db.prepare('SELECT code FROM invites WHERE room = ? AND player = ?').get(room.code, member.id)!.code as string }));
  }
  function commandForPlayer(code: string, playerId: string, input: RoomCommand): RoomReply {
      const request = validateRoomCommand(input);
      const payload = JSON.stringify(request.command);
      return transaction(() => {
        const room = read(code);
        const previous = db.prepare('SELECT payload, reply FROM receipts WHERE room = ? AND player = ? AND request = ?').get(code, playerId, request.id);
        if (previous) {
          if (previous.payload !== payload) return fail(409, 'This request ID was already used for a different command.');
          return { ...JSON.parse(previous.reply as string), view: roomView(room, playerId) } as RoomReply;
        }
        const before = snapshot(room);
        const receipt = dispatchRoom(room, playerId, request.command);
        save(room, before);
        db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, ?)').run(code, playerId, request.id, payload, JSON.stringify(receipt));
        return { ...receipt, view: roomView(room, playerId) };
      });
  }
  function memberRoom(token: string, code: string) {
    const playerId = auth!.current(token).account.playerId, room = read(code);
    if (!room.members.some(p => p.id === playerId)) return fail(403, 'You are not a member of this room.');
    return { playerId, room };
  }
  const accounts = auth && {
    ...auth,
    createRoom(token: string, input: unknown): RoomView {
      const host = auth.requireOrganizer(token).account.playerId;
      if (!object(input) || !keys(input, ['name']) || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) return fail(400, 'Choose a room name.');
      const name = input.name.trim();
      return transaction(() => {
        const code = randomBytes(6).toString('hex').toUpperCase();
        const room = createRoomDocument(dataset, code, name, host);
        db.prepare('INSERT INTO rooms VALUES (?, ?)').run(code, JSON.stringify(room));
        return roomView(room, host);
      });
    },
    listRooms(token: string) {
      const playerId = auth.current(token).account.playerId;
      return db.prepare('SELECT document FROM rooms').all().map(row => JSON.parse(String(row.document)) as RoomDocument)
        .filter(room => room.members.some(p => p.id === playerId)).map(room => ({ code: room.code, name: room.name }));
    },
    joinRoom(token: string, code: string): RoomView {
      return transaction(() => {
        const { room, playerId } = memberRoom(token, code);
        const member = room.members.find(p => p.id === playerId)!;
        if (!member.joined) { const before = snapshot(room); member.joined = true; room.revision++; save(room, before); }
        return roomView(room, playerId);
      });
    },
    viewRoom(token: string, code: string, after?: number): RoomView | { unchanged: true } {
      const { room, playerId } = memberRoom(token, code);
      return after === room.revision ? { unchanged: true } : roomView(room, playerId);
    },
    commandRoom(token: string, code: string, input: RoomCommand): RoomReply {
      const { playerId } = memberRoom(token, code);
      return commandForPlayer(code, playerId, input);
    },
    eventsRoom(token: string, code: string, after: number): RoomReplay {
      memberRoom(token, code);
      return replay(code, after);
    },
    roster(token: string): RoomRoster {
      auth.requireOrganizer(token);
      return { maxTeamSize: 3, members: dataset.players.map(p => ({ id: p.id, name: p.name, team: p.team, color: teamColor(p.team) })) };
    },
  };
  return {
    accounts,
    roster(): RoomRoster { localOnly(); return { maxTeamSize: 3, members: dataset.players.map(p => ({ id: p.id, name: p.name, team: p.team, color: teamColor(p.team) })) }; },
    create(input: { name: string; hostId: string }): RoomEntry {
      localOnly();
      if (!object(input) || !keys(input, ['name', 'hostId']) || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80
        || !dataset.players.some(p => p.id === input.hostId)) return fail(400, 'Choose a room name and a roster host.');
      return transaction(() => {
        const code = randomBytes(6).toString('hex').toUpperCase();
        const room = createRoomDocument(dataset, code, input.name.trim(), input.hostId);
        db.prepare('INSERT INTO rooms VALUES (?, ?)').run(code, JSON.stringify(room));
        for (const member of room.members) db.prepare('INSERT INTO invites VALUES (?, ?, ?)').run(code, member.id, secret());
        return { session: session(code, input.hostId), view: roomView(room, input.hostId), invites: roomInvites(room) };
      });
    },
    join(code: string, input: { inviteCode: string }): RoomEntry {
      localOnly();
      if (!object(input) || !keys(input, ['inviteCode']) || typeof input.inviteCode !== 'string' || input.inviteCode.length > 128) return fail(400, 'A personal invite code is required.');
      return transaction(() => {
        const row = db.prepare('SELECT player FROM invites WHERE room = ? AND code = ?').get(code, input.inviteCode);
        if (!row) return fail(403, 'Invalid personal invite code.');
        const room = read(code); const playerId = row.player as string;
        const member = room.members.find(p => p.id === playerId)!;
        if (!member.joined) { const before = snapshot(room); member.joined = true; room.revision++; save(room, before); }
        return { session: session(code, playerId), view: roomView(room, playerId) };
      });
    },
    logout(code: string, token: string): void {
      localOnly();
      if (typeof token !== 'string' || !token || token.length > 256) return fail(401, 'A valid room session is required.');
      // A single durable delete is idempotent, including after a lost acknowledgment or restart.
      const row = db.prepare('SELECT player FROM sessions WHERE token = ? AND room = ?').get(hash(token), code);
      db.prepare('DELETE FROM sessions WHERE token = ? AND room = ?').run(hash(token), code);
      if (row) revoked(row.player as string);
    },
    view(code: string, token: string, after?: number): RoomView | { unchanged: true } {
      localOnly();
      const playerId = authenticate(code, token); const room = read(code);
      return after === room.revision ? { unchanged: true } : roomView(room, playerId);
    },
    invites(code: string, token: string): { invites: RoomInvite[] } {
      localOnly();
      const playerId = authenticate(code, token); const room = read(code);
      if (room.hostId !== playerId) return fail(403, 'Only the host can view personal invitations.');
      return { invites: roomInvites(room) };
    },
    command(code: string, token: string, input: RoomCommand): RoomReply {
      localOnly();
      return commandForPlayer(code, authenticate(code, token), input);
    },
    /** The roster player behind a local room session (for Fanout channel subscription). */
    player(code: string, token: string): string { localOnly(); return authenticate(code, token); },
    events(code: string, token: string, after: number): RoomReplay {
      localOnly(); authenticate(code, token);
      return replay(code, after);
    },
    /** Calls `listener` after each committed change to `code`; callers must re-authorize before sending data. */
    watch(code: string, listener: () => void): () => void {
      const set = watchers.get(code) ?? new Set(); set.add(listener); watchers.set(code, set);
      return () => { set.delete(listener); if (!set.size) watchers.delete(code); };
    },
    flushOutbox,
    pendingPublications(): number { return Number(db.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n); },
    close() { if (!closed) { closed = true; watchers.clear(); db.close(); } },
  };
}
export type RoomService = ReturnType<typeof createRoomService>;
