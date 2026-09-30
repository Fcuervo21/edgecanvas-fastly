import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RoomReplay } from '../src/rooms/types';
import { gripHoldHeaders, sseEvent } from './grip';

export const HEARTBEAT_MS = 15_000;

/** Reads the client's last applied revision from `Last-Event-ID` or `?after=`. */
export function streamStart(request: IncomingMessage, url: URL): number {
  const value = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
  return typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : 0;
}

/**
 * Serves one room's public events as Server-Sent Events. `replay` must re-check the caller's
 * session and membership; it runs on connect, after every committed change and on each heartbeat,
 * so logout, disabling an account or removal closes the stream instead of leaking later events.
 */
export function serveRoomEvents(request: IncomingMessage, response: ServerResponse, after: number,
  replay: (after: number) => RoomReplay, watch: (listener: () => void) => () => void, heartbeatMs = HEARTBEAT_MS,
  fanout?: { code: string; playerId: string }) {
  let sent = after, closed = false;
  const first = replay(after); // Authentication errors become normal JSON errors before the stream opens.
  const headers = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' };
  /** Formats events newer than `sent` and advances it. */
  function format(result: RoomReplay): string {
    if ('reset' in result) {
      sent = result.revision;
      return `id: ${result.revision}\nevent: reset\ndata: ${JSON.stringify({ revision: result.revision })}\n\n`;
    }
    let text = '';
    for (const event of result.events) {
      if (event.revision <= sent) continue;
      sent = event.revision; text += sseEvent(event);
    }
    return text;
  }
  if (fanout) {
    // Fanout keeps the connection open after this response; later events arrive through GRIP publishing.
    const body = Buffer.from(`retry: 3000\n\n${format(first)}`);
    // A fixed length (not chunked) is what GRIP proxies expect for the initial held response.
    response.writeHead(200, { ...headers, ...gripHoldHeaders(fanout.code, fanout.playerId), 'content-length': body.length });
    response.end(body);
    return;
  }
  response.writeHead(200, headers);
  response.write('retry: 3000\n\n');
  function pump(heartbeat = false) {
    if (closed) return;
    try {
      const text = format(replay(sent));
      if (text) response.write(text);
      if (heartbeat) response.write(': ping\n\n');
    } catch {
      response.write('event: denied\ndata: {}\n\n');
      close(); response.end();
    }
  }
  response.write(format(first));
  const unwatch = watch(() => pump());
  const timer = setInterval(() => pump(true), heartbeatMs);
  function close() { if (!closed) { closed = true; clearInterval(timer); unwatch(); } }
  request.on('close', close);
  response.on('close', close);
}
