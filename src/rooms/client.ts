import type { Command } from '../game/types';
import type { RoomView, RoomSession, RoomCommand, RoomReply, RoomEffect } from './types';
import { readRoomStream, type StreamMessage } from './events';
/** `changed`: cells changed by others or confirmed; `local`: cells your own not-yet-confirmed moves just changed; `effect`: a bomb or shield played by someone else. */
export interface RoomCallbacks { view(view: RoomView, changed?: number[], local?: number[]): void; status(message: string, warning?: boolean): void; effect?(effect: RoomEffect): void; }
export const replyMessages: Record<string, string> = {
  INSUFFICIENT_PAINT: 'Not enough paint. Ask your host to advance the day.',
  NO_ITEM: 'Buy this tool in the shop first.', NO_CHANGE: 'Nothing to change here. You keep your paint.',
  HOST_ONLY: 'Only the host can advance the shared clock.', OUT_OF_BOUNDS: 'Aim inside the canvas.',
  INVALID_TIME: 'The room clock has already moved. Try again.',
  NO_MORE_DAYS: 'That was the last day with step data. Keep walking and wait for the next steps update.',
};
export type RoomConnection = RoomSession | { code: string; csrfToken: string };
/** While the live stream is healthy, a slow revision check still repairs a missed final event. */
export const LIVE_CHECK_MS = 15000;
export function connectRoom(session: RoomConnection, initial: RoomView, callbacks: RoomCallbacks, request: typeof fetch = fetch,
  options: { live?: boolean } = {}) {
  let revision = initial.revision, stopped = false, sending = false, polling = false, pollAgain = false, pollFailed = false;
  let live = false, lastPoll = Date.now(), streamDelay = 1000;
  let retry: ReturnType<typeof setTimeout> | undefined, reconnect: ReturnType<typeof setTimeout> | undefined;
  const queue: RoomCommand[] = [];
  const active = new Set<AbortController>();
  const path = `/api/rooms/${encodeURIComponent(session.code)}`;
  const interval = setInterval(() => { if (!live || Date.now() - lastPoll >= LIVE_CHECK_MS) void poll(); }, 1000);
  const headers = () => ({ 'Content-Type': 'application/json', ...('token' in session ? { Authorization: `Bearer ${session.token}` } : { 'X-CSRF-Token': session.csrfToken }) });
  function stop() {
    stopped = true; live = false; clearInterval(interval); clearTimeout(retry); clearTimeout(reconnect);
    queue.length = 0; active.forEach(controller => controller.abort());
  }
  function denied(message?: string) { stop(); callbacks.status(message ?? 'Session expired. Rejoin with your personal invite.', true); }
  function onStream(message: StreamMessage) {
    streamDelay = 1000;
    if (message.type === 'denied') return denied();
    // Events are public prompts; the private view (balance, inventory) always comes from an authenticated fetch.
    const next = message.type === 'room' ? message.event.revision : message.revision;
    if (next > revision) void poll();
  }
  async function stream() {
    if (stopped) return;
    const controller = new AbortController(); active.add(controller);
    try {
      const response = await readRoomStream(`${path}/events`, { credentials: 'same-origin', signal: controller.signal,
        headers: { ...headers(), 'Last-Event-ID': String(revision) } }, onStream, request, () => { live = true; void poll(); });
      if (response.status === 401 || response.status === 403) {
        const data = await response.json().catch(() => ({}));
        return denied(data.error);
      }
    } catch { /* Network loss: fall back to polling and reconnect below. */ }
    finally { live = false; active.delete(controller); }
    if (stopped) return;
    reconnect = setTimeout(() => { void stream(); }, streamDelay);
    streamDelay = Math.min(streamDelay * 2, 30000);
  }
  if (options.live) void stream();
  async function get(url: string, init: RequestInit = {}) {
    const controller = new AbortController(); active.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await request(url, { ...init, credentials: 'same-origin', signal: controller.signal, headers: headers() });
      const data = await response.json();
      if (response.status === 401 || response.status === 403) denied(data.error);
      return { response, data };
    } finally { clearTimeout(timeout); active.delete(controller); }
  }
  function accept(view: RoomView, changed: number[] = []) {
    if (!stopped && view.revision > revision) { revision = view.revision; callbacks.view(view, changed); }
  }
  async function drain() {
    if (stopped || sending || !queue.length) return;
    sending = true;
    try {
      const { response, data } = await get(`${path}/commands`, { method: 'POST', body: JSON.stringify(queue[0]) });
      if (stopped) return;
      if (response.status >= 500) throw new Error('Server unavailable');
      queue.shift();
      if (!response.ok) callbacks.status(data.error ?? 'This move was rejected.', true);
      else {
        const reply = data as RoomReply; accept(reply.view, reply.changed);
        callbacks.status(reply.code === 'OK' ? 'Connected · changes saved' : replyMessages[reply.code] ?? reply.message ?? 'Move rejected.', reply.code !== 'OK');
      }
    } catch {
      if (!stopped) {
        callbacks.status('Reconnecting · your move is queued safely', true);
        retry = setTimeout(() => { sending = false; void drain(); }, 1500);
        return;
      }
    }
    sending = false;
    if (!stopped) void drain();
  }
  async function poll(): Promise<void> {
    if (stopped) return;
    if (polling) { pollAgain = true; return; }
    polling = true; pollAgain = false; lastPoll = Date.now();
    try {
      const { response, data } = await get(`${path}?after=${revision}`);
      if (!stopped && response.ok) {
        if (!data.unchanged) accept(data);
        if (pollFailed && !queue.length) { callbacks.status('Connected · changes saved', false); pollFailed = false; }
      } else if (!stopped) { pollFailed = true; callbacks.status('Connection interrupted. Retrying…', true); }
    } catch { if (!stopped) { pollFailed = true; callbacks.status('Connection interrupted. Retrying…', true); } }
    finally { polling = false; }
    // A change announced during an in-flight fetch may be newer than its response.
    if (pollAgain && !stopped) await poll();
  }
  return {
    submit(command: Command) {
      if (stopped) return false;
      if (queue.length >= 32) { callbacks.status('Catching up with your brush. Please pause a moment.', true); return false; }
      queue.push({ id: crypto.randomUUID(), command }); void drain(); return true;
    }, poll, stop,
  };
}
