import { dispatch } from '../game/engine';
import type { Cell, Command, GameState } from '../game/types';
import { tileCells, unpack, type EdgeEvent, type EdgeReply, type EdgeView, type TileUpdate } from '../edge/types';
import { replyMessages, type RoomCallbacks } from './client';
import { createSSEParser, readEventStream } from './events';
import type { RoomCommand } from './types';

const revisionOf = (view: EdgeView) => view.edge.tiles.reduce((a, b) => a + b, 0) + view.edge.clock + view.edge.wallet + view.members.filter(m => m.joined).length;

/** Applies tile updates that are newer than what the view holds; returns the board indices that changed. */
export function mergeTiles(view: EdgeView, tiles: TileUpdate[]): number[] {
  const changed: number[] = [];
  for (const update of tiles) {
    if (update.version <= (view.edge.tiles[update.tile] ?? 0)) continue;
    view.edge.tiles[update.tile] = update.version;
    tileCells(update.tile).forEach((index, i) => {
      const cell = unpack(update.cells[i]), old = view.state.cells[index];
      if (old.owner !== cell.owner || old.shieldUntil !== cell.shieldUntil) changed.push(index);
      view.state.cells[index] = cell;
    });
  }
  view.revision = revisionOf(view);
  return changed;
}
/** Merges a command reply: newer tiles, and the private wallet only if it is not older than ours. */
export function mergeReply(view: EdgeView, reply: EdgeReply): number[] {
  const changed = mergeTiles(view, reply.tiles);
  if (reply.wallet.version >= view.edge.wallet && reply.clock.version >= view.edge.clock) {
    view.state = { ...view.state, ...reply.wallet.state, cells: view.state.cells };
    view.edge.wallet = reply.wallet.version; view.edge.clock = reply.clock.version;
    view.autoAdvance = reply.clock.auto ?? null; view.days = reply.clock.days ?? view.days;
  }
  view.revision = revisionOf(view);
  return changed;
}
/** Merges a full snapshot tile by tile, so a stale snapshot never rolls back newer live updates. */
export function mergeView(view: EdgeView, next: EdgeView, keepWallet = false): number[] {
  const tiles = next.edge.tiles.map((version, tile) => ({ tile, version, cells: tileCells(tile).map(i => [next.state.cells[i].owner, next.state.cells[i].shieldUntil] as [string | null, number]) }));
  const changed = mergeTiles(view, tiles);
  if (next.edge.clock >= view.edge.clock) { view.autoAdvance = next.autoAdvance ?? null; view.days = next.days ?? view.days; }
  // While your own moves are unanswered the wallet comes only from their answers: a snapshot may already include their price.
  if (!keepWallet && next.edge.wallet >= view.edge.wallet && next.edge.clock >= view.edge.clock) {
    view.state = { ...next.state, cells: view.state.cells };
    view.edge.wallet = next.edge.wallet; view.edge.clock = next.edge.clock;
  }
  view.members = next.members;
  view.ink = next.ink ?? view.ink;
  view.revision = revisionOf(view);
  return changed;
}

/**
 * Browser connection to an all-Fastly room: commands go to Compute one at a time (retried under
 * the same ID), the Fanout stream delivers public tile, clock and roster events, and a periodic
 * snapshot repairs anything missed. Private wallet data only ever comes from authenticated replies.
 */
export function connectEdgeRoom(session: { code: string; csrfToken: string }, initial: EdgeView, callbacks: RoomCallbacks,
  request: typeof fetch = fetch, options: { live?: boolean } = {}) {
  const view: EdgeView = structuredClone(initial);
  /** A snapshot arrived while moves were pending, so its wallet was set aside; take a fresh one once they are answered. */
  let behind = false;
  let stopped = false, sending = false, polling = false, pollAgain = false, live = false, failed = false;
  let lastPoll = Date.now(), streamDelay = 1000;
  let retry: ReturnType<typeof setTimeout> | undefined, reconnect: ReturnType<typeof setTimeout> | undefined;
  /** What a move does, worked out once when it is made: cells it paints, paint it costs, tools it adds or uses. */
  interface Prediction { cells: Map<number, Cell>; spent: number; bomb: number; shield: number }
  /** Moves not yet answered by the server. `sent` freezes an item: a retry must carry exactly what was sent. */
  const queue: (RoomCommand & { sent?: boolean; predicted?: Prediction })[] = [];
  const active = new Set<AbortController>();
  const path = `/api/rooms/${encodeURIComponent(session.code)}`;
  /** Ids of this player's own moves, so an effect the server announces for them is not played a second time. */
  const ownIds = new Set<string>();
  /** Cells the screen already shows because of this player's unanswered moves, so each is reported (for effects) once. */
  const shownLocal = new Set<number>();
  /** Pixels other players are drawing right now, announced before the slow save: shown for a while, then replaced by the saved tiles or dropped. */
  const ghosts = new Map<number, { owner: string; until: number }>();
  const GHOST_MS = 10000;
  let ghostTimer: ReturnType<typeof setTimeout> | undefined;
  /** A saved cell replaces its preview, whatever it now says. */
  const settled = (changed: number[]) => { for (const index of changed) ghosts.delete(index); return changed; };
  function expireGhosts() {
    ghostTimer = undefined;
    const now = Date.now(), gone: number[] = [];
    for (const [index, ghost] of ghosts) if (ghost.until <= now) { ghosts.delete(index); gone.push(index); }
    if (gone.length && !stopped) emit(gone);
    watchGhosts();
  }
  function watchGhosts() {
    if (stopped || ghostTimer || !ghosts.size) return;
    ghostTimer = setTimeout(expireGhosts, Math.max(50, Math.min(...[...ghosts.values()].map(g => g.until)) - Date.now()));
  }
  /**
   * Your own drawing, previewed to the room without waiting for the save. Previews leave one request at a time: requests
   * sent side by side can overtake each other, and the other screens would then draw the end of your line before its
   * middle. Whatever is drawn while one is in flight waits and goes out together, in drawing order, right after it.
   */
  const inkQueue = new Set<number>();
  let inkSending = false, inkTimer: ReturnType<typeof setTimeout> | undefined, lastInk = 0;
  function pumpInk() {
    inkTimer = undefined;
    if (inkSending || stopped || !view.ink || !inkQueue.size) return;
    const cells = [...inkQueue].slice(0, 400);
    for (const index of cells) inkQueue.delete(index);
    inkSending = true; lastInk = Date.now();
    // A preview is best effort and short lived: a slow or failed one is dropped after 3 seconds so it cannot hold back the next.
    void call(`${path}/ink`, { method: 'POST', body: JSON.stringify({ cells }) }, { 'X-Ink-Ticket': view.ink }, 3000).catch(() => {})
      .finally(() => { inkSending = false; pumpInk(); });
  }
  function sendInk(cells: Iterable<number>) {
    if (!pushes || stopped || !view.ink) return;
    for (const index of cells) inkQueue.add(index);
    if (inkSending || inkTimer || !inkQueue.size) return;
    const wait = 100 - (Date.now() - lastInk);
    if (wait <= 0) pumpInk(); else inkTimer = setTimeout(pumpInk, wait);
  }
  /**
   * What the player sees: the confirmed room plus what their own unanswered moves were predicted to do. Each move's
   * prediction is fixed when it is made and is never recomputed against cells that may already include it, so the
   * paint counter cannot be charged twice or refunded early. Confirmed data always wins: an answered move drops out
   * of the queue and the confirmed room already includes it. The copy is shallow (cells are replaced, never edited in
   * place), so building it stays cheap even 30 times a second.
   */
  function withPending(): { view: EdgeView; local: number[] } {
    const state: GameState = { ...view.state, cells: view.state.cells.slice(), inventory: { ...view.state.inventory } }, local: number[] = [];
    // Other players' live previews sit under your own unanswered moves. They are shown only: prices and predictions never use them.
    for (const [index, ghost] of ghosts) state.cells[index] = { owner: ghost.owner, shieldUntil: 0 };
    for (const { predicted } of queue) {
      if (!predicted) continue;
      for (const [index, cell] of predicted.cells) { state.cells[index] = cell; if (!shownLocal.has(index)) { shownLocal.add(index); local.push(index); } }
      state.spent += predicted.spent; state.balance -= predicted.spent;
      state.inventory.bomb += predicted.bomb; state.inventory.shield += predicted.shield;
    }
    if (!queue.length) shownLocal.clear();
    return { view: { ...view, state }, local };
  }
  /** The state on screen right now (confirmed plus predicted), without reporting cells as newly shown. */
  function displayed(): GameState {
    const state: GameState = { ...view.state, cells: view.state.cells.slice(), inventory: { ...view.state.inventory } };
    for (const { predicted } of queue) {
      if (!predicted) continue;
      for (const [index, cell] of predicted.cells) state.cells[index] = cell;
      state.spent += predicted.spent; state.balance -= predicted.spent;
      state.inventory.bomb += predicted.bomb; state.inventory.shield += predicted.shield;
    }
    return state;
  }
  /** The effect of a move on what is currently on screen, or nothing when the rules refuse it. */
  function predict(command: Command): Prediction | undefined {
    if (command.type !== 'stroke' && command.type !== 'apply' && command.type !== 'buy') return undefined;
    const base = displayed(), result = dispatch(base, command, view.dataset);
    if (result.code !== 'OK') return undefined;
    return { cells: new Map(result.changed.map(index => [index, result.state.cells[index]])), spent: result.state.spent - base.spent,
      bomb: result.state.inventory.bomb - base.inventory.bomb, shield: result.state.inventory.shield - base.inventory.shield };
  }
  let lastEmit = 0, emitTimer: ReturnType<typeof setTimeout> | undefined;
  function emit(changed: number[] = []) {
    clearTimeout(emitTimer); emitTimer = undefined; lastEmit = Date.now();
    const overlay = withPending();
    callbacks.view(overlay.view, changed, overlay.local);
  }
  const publish = (changed: number[] = []) => { if (!stopped) emit(changed); };
  /** Updates caused by drawing come at most about 30 times a second; the last one always goes out. */
  function publishSoon() {
    if (stopped) return;
    const wait = 33 - (Date.now() - lastEmit);
    if (wait <= 0) emit(); else emitTimer ??= setTimeout(() => { emitTimer = undefined; if (!stopped) emit(); }, wait);
  }
  // Pushes are used only when the server says it can publish them; otherwise the browser polls.
  const pushes = options.live === true && initial.live !== false;
  // Snapshots cost about 200 lookups, so background tabs never poll: every 60 s with a healthy stream (events do the real
  // work), 5 s while the stream is down, 10 s when the server cannot push at all.
  const hidden = () => typeof document !== 'undefined' && document.hidden === true;
  const interval = setInterval(() => {
    if (hidden()) return;
    const wait = live ? 60000 : options.live === true && !pushes ? 10000 : 5000;
    if (Date.now() - lastPoll >= wait) void poll();
  }, 1000);
  const shown = () => { if (!hidden() && !stopped) void poll(); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', shown);
  function stop() {
    stopped = true; live = false; clearInterval(interval); clearTimeout(retry); clearTimeout(reconnect); clearTimeout(emitTimer); clearTimeout(ghostTimer); clearTimeout(inkTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', shown);
    queue.length = 0; active.forEach(controller => controller.abort());
  }
  function denied(message?: string) { stop(); callbacks.status(message ?? 'Your session ended. Sign in again.', true); }
  async function call(url: string, init: RequestInit = {}, headers: Record<string, string> = {}, timeoutMs = 15000) {
    const controller = new AbortController(); active.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(url, { ...init, credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, ...headers } });
      const data = await response.json();
      if (response.status === 401) denied(data.error);
      return { response, data };
    } finally { clearTimeout(timeout); active.delete(controller); }
  }
  function onEvent(name: string, data: string) {
    streamDelay = 1000;
    let event: EdgeEvent;
    try { event = JSON.parse(data) as EdgeEvent; } catch { return; }
    if (name === 'tile' && event.type === 'tile') { const changed = settled(mergeTiles(view, [event])); if (changed.length) publish(changed); }
    else if (name === 'ink' && event.type === 'ink') showInk(event);
    else if (name === 'fx' && event.type === 'fx') { if (!ownIds.has(event.id)) callbacks.effect?.(event); }
    // A new day changes everyone's credits, and a new member changes the roster: refresh privately.
    else if (name === 'clock' && event.type === 'clock' && event.version > view.edge.clock) void poll();
    else if (name === 'roster') void poll();
  }
  function showInk(event: Extract<EdgeEvent, { type: 'ink' }>) {
    if (event.from === view.state.playerId) return;
    const changed: number[] = [], until = Date.now() + GHOST_MS;
    for (const index of event.cells) {
      const cell = Number.isInteger(index) ? view.state.cells[index] : undefined;
      // Already theirs, or under a shield: a preview cannot change that, so it would only mislead.
      if (!cell || cell.owner === event.team || (cell.owner && cell.shieldUntil > view.state.minute)) continue;
      const before = ghosts.get(index);
      ghosts.set(index, { owner: event.team, until });
      if (before?.owner !== event.team) changed.push(index);
    }
    if (changed.length) { publish(changed); watchGhosts(); }
  }
  async function stream() {
    if (stopped) return;
    const controller = new AbortController(); active.add(controller);
    try {
      const response = await readEventStream(`${path}/events`, { credentials: 'same-origin', signal: controller.signal },
        createSSEParser(onEvent), request, () => { live = true; void poll(); });
      if (response.status === 401) return denied((await response.json().catch(() => ({}))).error);
    } catch { /* Network loss: snapshots continue and the stream reconnects below. */ }
    finally { live = false; active.delete(controller); }
    if (stopped) return;
    reconnect = setTimeout(() => { void stream(); }, streamDelay);
    streamDelay = Math.min(streamDelay * 2, 30000);
  }
  if (pushes) void stream();
  async function drain() {
    if (stopped || sending || !queue.length) return;
    sending = true;
    try {
      queue[0].sent = true;
      const { response, data } = await call(`${path}/commands`, { method: 'POST', body: JSON.stringify({ id: queue[0].id, command: queue[0].command }) },
        { 'X-Wallet-Version': String(view.edge.wallet), 'X-Clock-Version': String(view.edge.clock) });
      if (stopped) return;
      if (response.status >= 500 || response.status === 429) throw new Error('Retry later');
      queue.shift();
      if (!response.ok) callbacks.status(data.error ?? 'This move was rejected.', true);
      else {
        const reply = data as EdgeReply;
        settled(mergeReply(view, reply));
        publish(); // your own cells were already on screen, so nothing is announced again
        callbacks.status(reply.code === 'OK' ? 'Connected · changes saved' : replyMessages[reply.code] ?? reply.message ?? 'Move rejected.', reply.code !== 'OK');
      }
    } catch {
      if (!stopped) {
        // Same ID on retry: the edge charges a command once even if the first attempt did land.
        callbacks.status('Reconnecting · your move is queued safely', true);
        retry = setTimeout(() => { sending = false; void drain(); }, 1500);
        return;
      }
    }
    sending = false;
    if (!stopped && !queue.length && behind) { behind = false; void poll(); }
    if (!stopped) void drain();
  }
  async function poll(): Promise<void> {
    if (stopped) return;
    if (polling) { pollAgain = true; return; }
    polling = true; pollAgain = false; lastPoll = Date.now();
    try {
      const { response, data } = await call(path);
      if (!stopped && response.ok) {
        // With moves pending, only the room's cells and members are taken; the wallet waits for the answers (see mergeView).
        const holding = queue.length > 0; if (holding) behind = true;
        publish(settled(mergeView(view, data as EdgeView, holding)));
        if (failed && !queue.length) { callbacks.status('Connected · changes saved', false); failed = false; }
      } else if (!stopped) { failed = true; callbacks.status('Connection interrupted. Retrying…', true); }
    } catch { if (!stopped) { failed = true; callbacks.status('Connection interrupted. Retrying…', true); } }
    finally { polling = false; }
    if (pollAgain && !stopped) await poll();
  }
  return {
    submit(command: Command) {
      if (stopped) return false;
      if (queue.length >= 32) { callbacks.status('Catching up with your brush. Please pause a moment.', true); return false; }
      // Strokes drawn while an earlier request is in flight join the next unsent stroke: one round trip carries them all.
      const last = queue.at(-1), predicted = predict(command);
      if (predicted) sendInk(predicted.cells.keys());
      if (command.type === 'stroke' && last && !last.sent && last.command.type === 'stroke' && last.command.points.length + command.points.length <= 4000) {
        last.command = { type: 'stroke', points: [...last.command.points, ...command.points] };
        if (predicted) {
          const before = last.predicted;
          last.predicted = before ? { cells: new Map([...before.cells, ...predicted.cells]), spent: before.spent + predicted.spent, bomb: before.bomb + predicted.bomb, shield: before.shield + predicted.shield } : predicted;
        }
      } else { const id = crypto.randomUUID(); ownIds.add(id); queue.push({ id, command, predicted }); }
      publishSoon(); void drain(); return true;
    },
    /** Host only: `at` is the minute of the UTC day for the daily change, or null to move days by hand again. */
    async schedule(at: number | null): Promise<boolean> {
      if (stopped) return false;
      try {
        const { response, data } = await call(`${path}/schedule`, { method: 'POST', body: JSON.stringify({ at }) });
        if (!response.ok) { callbacks.status(data.error ?? 'Could not change the schedule.', true); return false; }
        publish(settled(mergeView(view, data as EdgeView, queue.length > 0)));
        return true;
      } catch { if (!stopped) callbacks.status('Could not reach the room. Try again.', true); return false; }
    },
    poll, stop,
  };
}
