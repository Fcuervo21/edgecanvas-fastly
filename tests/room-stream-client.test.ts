import { afterEach, expect, test, vi } from 'vitest';
import { connectRoom } from '../src/rooms/client';
import { createStreamParser, type StreamMessage } from '../src/rooms/events';
import type { RoomView } from '../src/rooms/types';

const initial = { revision: 3, code: 'ROOM' } as RoomView;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (text: string) => new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
afterEach(() => vi.useRealTimers());

test('the parser handles split chunks, CRLF, comments, resets and malformed data', () => {
  const seen: StreamMessage[] = [];
  const parse = createStreamParser(message => seen.push(message));
  const event = JSON.stringify({ revision: 4, minute: 0, cells: [], rosterChanged: false });
  const text = `retry: 3000\r\n\r\n: ping\n\nid: 4\nevent: room\ndata: ${event}\n\nevent: room\ndata: {broken\n\nevent: reset\ndata: {"revision":9}\n\nevent: denied\ndata: {}\n\n`;
  for (let i = 0; i < text.length; i += 7) parse(text.slice(i, i + 7));
  expect(seen).toEqual([{ type: 'room', event: JSON.parse(event) }, { type: 'reset', revision: 9 }, { type: 'denied' }]);
});

test('reconnects with the last applied revision, ignores stale events and falls back to polling', async () => {
  vi.useFakeTimers();
  const streams: string[] = []; let polls = 0;
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/events')) {
      streams.push(new Headers(init?.headers).get('Last-Event-ID')!);
      if (streams.length === 1) return sse('event: room\ndata: {"revision":2,"minute":0,"cells":[],"rosterChanged":false}\n\nevent: room\ndata: {"revision":5,"minute":0,"cells":[],"rosterChanged":false}\n\n');
      throw new TypeError('offline');
    }
    polls++;
    return json({ ...initial, revision: 5 });
  });
  const seen: number[] = [];
  const client = connectRoom({ code: 'ROOM', token: 'secret' }, initial, { view: view => seen.push(view.revision), status: () => {} }, request as typeof fetch, { live: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual([5]);
  const afterOpen = polls;
  await vi.advanceTimersByTimeAsync(1000);
  expect(streams).toEqual(['3', '5']);
  await vi.advanceTimersByTimeAsync(3000);
  expect(polls).toBeGreaterThanOrEqual(afterOpen + 3); // The stream is down, so one-second polling resumes.
  client.stop();
});

test('a denied stream stops queued spending', async () => {
  const statuses: string[] = [];
  const request = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/events') ? sse('event: denied\ndata: {}\n\n') : json({ unchanged: true }));
  const client = connectRoom({ code: 'ROOM', csrfToken: 'csrf' }, initial, { view: () => {}, status: message => statuses.push(message) }, request as typeof fetch, { live: true });
  await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0));
  expect(statuses.join(' ')).toMatch(/expired/i);
  expect(client.submit({ type: 'buy', item: 'bomb' })).toBe(false);
});
