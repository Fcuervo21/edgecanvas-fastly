import { createHash, createHmac, createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import type { RoomEvent } from '../src/rooms/types';
import type { RoomPublisher } from './service';

/** Fastly Fanout's published Grip-Sig verification key (ES256), from the Fanout guide. */
export const FASTLY_GRIP_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAECKo5A1ebyFcnmVV8SE5On+8G81Jy
BjSvcrx4VLetWCjuDAmppTo3xM/zz763COTCgHfp/6lPdCyYjjqc+GM7sw==
-----END PUBLIC KEY-----`;

export interface GripVerifier { (header: string | string[] | undefined): boolean }

/**
 * Accepts only requests forwarded by Fanout: an unexpired ES256 JWT with the expected issuer
 * (`fastly:<service-id>` when hosted). A local Pushpin signs with HS256 and a shared `secret`
 * instead; each verifier accepts exactly one algorithm. Anything else is served as a normal, direct SSE stream.
 */
export function gripVerifier(options: ({ publicKey: string | KeyObject } | { secret: string }) & { issuer?: string; now?: () => number }): GripVerifier {
  const key = 'publicKey' in options ? (typeof options.publicKey === 'string' ? createPublicKey(options.publicKey) : options.publicKey) : undefined;
  const secret = 'secret' in options ? options.secret : undefined;
  if (secret !== undefined && secret.length < 16) throw new Error('Use a GRIP signing secret of at least 16 characters.');
  const now = options.now ?? Date.now;
  function signed(data: string, alg: unknown, signature: Buffer) {
    if (key) return alg === 'ES256' && verify('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }, signature);
    const expected = createHmac('sha256', secret!).update(data).digest();
    return alg === 'HS256' && signature.length === expected.length && timingSafeEqual(signature, expected);
  }
  return header => {
    if (typeof header !== 'string' || header.length > 4096) return false;
    const parts = header.split('.');
    if (parts.length !== 3) return false;
    try {
      const head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (!signed(`${parts[0]}.${parts[1]}`, head?.alg, Buffer.from(parts[2], 'base64url'))) return false;
      if (!Number.isFinite(claims?.exp) || claims.exp * 1000 <= now()) return false;
      return options.issuer === undefined || claims.iss === options.issuer;
    } catch { return false; }
  };
}

/** Channel names carry no room secrets or participant names. */
export const roomChannel = (code: string) => `room-${code}`;
export const playerChannel = (playerId: string) => `player-${createHash('sha256').update(`edgecanvas-player:${playerId}`).digest('hex').slice(0, 32)}`;
export const sseEvent = (event: RoomEvent) => `id: ${event.revision}\nevent: room\ndata: ${JSON.stringify(event)}\n\n`;

/** GRIP response headers that ask Fanout to hold the stream open on the room and player channels. */
export function gripHoldHeaders(code: string, playerId: string): Record<string, string | string[]> {
  return {
    'grip-hold': 'stream',
    'grip-channel': `${roomChannel(code)}, ${playerChannel(playerId)}`,
    'grip-keep-alive': ': ping\\n\\n; format=cstring; timeout=20',
  };
}

/**
 * Publishes committed events to a GRIP publish endpoint: Fastly Fanout
 * (`https://api.fastly.com/service/<id>/publish/`, with a `Fastly-Key`) or a local Pushpin
 * (`http://127.0.0.1:5561/publish/`). The token is only ever read from the environment.
 */
export function gripPublisher(options: { endpoint: string; token?: string; request?: typeof fetch }) {
  const request = options.request ?? fetch;
  const url = new URL(options.endpoint);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('GRIP publishing requires HTTPS outside loopback.');
  async function send(items: unknown[]) {
    const response = await request(url, { method: 'POST', body: JSON.stringify({ items }), signal: AbortSignal.timeout(10000),
      // The API token is only ever sent to Fastly's own API, never to a local or third-party endpoint.
      headers: { 'content-type': 'application/json', ...(options.token && url.hostname === 'api.fastly.com' ? { 'fastly-key': options.token } : {}) } });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`GRIP publish failed with HTTP ${response.status}.`);
  }
  const publish: RoomPublisher = (room, event) => send([{ channel: roomChannel(room), id: String(event.revision),
    formats: { 'http-stream': { content: sseEvent(event) } } }]);
  /** Ends every held stream of this player; each browser reconnects and is authorized again. */
  const closeStreams = (playerId: string) => send([{ channel: playerChannel(playerId), formats: { 'http-stream': { action: 'close' } } }]);
  return { publish, closeStreams };
}
