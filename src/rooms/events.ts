import type { RoomEvent } from './types';

export type StreamMessage =
  | { type: 'room'; event: RoomEvent }
  | { type: 'reset'; revision: number }
  | { type: 'denied' };

/** Incremental Server-Sent Events parser; tolerates arbitrary chunk boundaries. Comments and empty data are skipped. */
export function createSSEParser(onEvent: (name: string, data: string) => void) {
  let buffer = '';
  function dispatch(block: string) {
    let name = 'message'; const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') name = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length || name !== 'message') onEvent(name, data.join('\n'));
  }
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n?/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) { dispatch(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
  };
}

/** Parser for the Node authority's room stream (`room`, `reset`, `denied`). */
export function createStreamParser(onMessage: (message: StreamMessage) => void) {
  return createSSEParser((name, data) => {
    if (name === 'denied') return onMessage({ type: 'denied' });
    if (!data) return;
    let body: unknown;
    try { body = JSON.parse(data); } catch { return; }
    if (!body || typeof body !== 'object') return;
    const revision = (body as { revision?: unknown }).revision;
    if (!Number.isSafeInteger(revision)) return;
    if (name === 'room') onMessage({ type: 'room', event: body as RoomEvent });
    else if (name === 'reset') onMessage({ type: 'reset', revision: revision as number });
  });
}

/**
 * Reads the authenticated room stream with `fetch`, so bearer and CSRF headers work without putting
 * credentials in the URL (the browser `EventSource` cannot send headers). Resolves when the stream ends.
 */
export function readRoomStream(url: string, init: RequestInit, onMessage: (message: StreamMessage) => void,
  request: typeof fetch = fetch, onOpen: () => void = () => {}): Promise<Response> {
  return readEventStream(url, init, createStreamParser(onMessage), request, onOpen);
}

/** Reads any event stream with `fetch`, feeding decoded chunks to `parse`. Resolves when the stream ends. */
export async function readEventStream(url: string, init: RequestInit, parse: (chunk: string) => void,
  request: typeof fetch = fetch, onOpen: () => void = () => {}): Promise<Response> {
  const response = await request(url, { ...init, headers: { ...init.headers, Accept: 'text/event-stream' } });
  if (!response.ok || !response.body || !/^text\/event-stream/i.test(response.headers.get('content-type') ?? '')) return response;
  onOpen();
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return response;
    parse(value);
  }
}
