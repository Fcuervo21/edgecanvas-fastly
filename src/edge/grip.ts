import type { EdgeEvent } from './types';

/** Fastly Fanout's published Grip-Sig key (ES256), the same key as server/grip.ts, as a JWK. */
export const FASTLY_GRIP_JWK = { kty: 'EC', crv: 'P-256', x: 'CKo5A1ebyFcnmVV8SE5On-8G81JyBjSvcrx4VLetWCg', y: '7gwJqaU6N8TP88--twjkwoB36f-pT3QsmI46nPhjO7M' };

const encoder = new TextEncoder();
function base64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
const decodeJSON = (text: string) => JSON.parse(new TextDecoder().decode(base64url(text)));

/**
 * WebCrypto Grip-Sig verifier that runs on Compute and in Node. Fastly signs with ES256 (issuer
 * `fastly:<service id>` when hosted); a local Pushpin signs with HS256 and a shared secret. Each
 * verifier accepts exactly one algorithm.
 */
export function edgeGripVerifier(options: ({ jwk: JsonWebKey } | { secret: string }) & { issuer?: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  const alg = 'jwk' in options ? 'ES256' : 'HS256';
  const key = 'jwk' in options
    ? crypto.subtle.importKey('jwk', options.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    : crypto.subtle.importKey('raw', encoder.encode(options.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return async (header: string | null): Promise<boolean> => {
    if (!header || header.length > 4096) return false;
    const parts = header.split('.');
    if (parts.length !== 3) return false;
    try {
      if (decodeJSON(parts[0])?.alg !== alg) return false;
      const data = encoder.encode(`${parts[0]}.${parts[1]}`), signature = base64url(parts[2]);
      const valid = alg === 'ES256'
        ? await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' } as Algorithm, await key, signature, data)
        : await crypto.subtle.verify('HMAC', await key, signature, data);
      if (!valid) return false;
      const claims = decodeJSON(parts[1]);
      if (!Number.isFinite(claims?.exp) || claims.exp * 1000 <= now()) return false;
      return options.issuer === undefined || claims.iss === options.issuer;
    } catch { return false; }
  };
}

async function hash(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
/** Channel names carry no room secrets or participant names. */
export const roomChannel = (code: string) => `room-${code}`;
export const playerChannel = async (playerId: string) => `player-${(await hash(`edgecanvas-player:${playerId}`)).slice(0, 32)}`;
export const edgeSSE = (event: EdgeEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

export async function gripHoldHeaders(code: string, playerId: string): Promise<Record<string, string>> {
  return {
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
    'grip-hold': 'stream',
    'grip-channel': `${roomChannel(code)}, ${await playerChannel(playerId)}`,
    'grip-keep-alive': ': ping\\n\\n; format=cstring; timeout=20',
  };
}

/** Channel of the organizer's live check: a stream nobody but the organizer tool can open, and a ping it can publish. */
export const ADMIN_CHANNEL = 'admin-health';

/** GRIP publishing through any `send(items)` transport (Fastly's publish API or a local Pushpin). */
export function edgePublisher(send: (items: unknown[]) => Promise<void>) {
  return {
    publish: (room: string, event: EdgeEvent) => send([{ channel: roomChannel(room), formats: { 'http-stream': { content: edgeSSE(event) } } }]),
    /** One ping for the live check (`npm run edge:admin -- live`): proves publishing and delivery end to end. */
    publishHealth: (at: number) => send([{ channel: ADMIN_CHANNEL, formats: { 'http-stream': { content: `event: ping\ndata: ${JSON.stringify({ at })}\n\n` } } }]),
    /** Several events in one API request (each still counts as one message). */
    publishBatch: (room: string, events: EdgeEvent[]) => send(events.map(event => ({ channel: roomChannel(room), formats: { 'http-stream': { content: edgeSSE(event) } } }))),
    /** Ends this player's held streams (logout, reset, disable); browsers reconnect and re-authorize. */
    closeStreams: async (playerId: string) => send([{ channel: await playerChannel(playerId), formats: { 'http-stream': { action: 'close' } } }]),
  };
}
