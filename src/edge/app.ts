import type { Dataset } from '../game/types';
import { RoomError } from '../rooms/errors';
import { createEdgeAccounts, validCsrf, ACCOUNT_SESSION_MS } from './accounts';
import { createEdgeAuthority } from './authority';
import { ADMIN_CHANNEL, gripHoldHeaders } from './grip';
import type { EdgeKV } from './kv';
import { issueInkTicket, readInkTicket } from './ink-ticket';
import { sha256 } from './passwords';
import { clientKey, createKvThrottle, type Throttle } from './throttle';
import type { EdgeEvent } from './types';

const COOKIE = 'edgecanvas_account';
const DATASET = 'dataset';
const LIMIT = 64 * 1024, DATASET_LIMIT = 4 * 1024 * 1024;
/** Made-up but well-formed session cookies tolerated per network per minute. */
const SESSION_MISSES = 40;
/** Live previews: recorded uses allowed per 10 seconds, when one request in INK_SAMPLE is recorded (so about 200 previews). */
const INK_BUDGET = 50, INK_SAMPLE = 4;

export interface EdgeAppOptions {
  kv: EdgeKV;
  /** Secret Store values (or async getters, read only by the routes that need them). `adminToken` guards organizer tooling; `pepper` keys password hashes. */
  adminToken: string | (() => Promise<string>); pepper: string | (() => Promise<string>);
  publish?: (room: string, event: EdgeEvent) => Promise<void>;
  publishBatch?: (room: string, events: EdgeEvent[]) => Promise<void>;
  /** Whether events can really be published (Compute: the Fanout token is set). Defaults to "a publisher was given". */
  pushReady?: () => Promise<boolean>;
  /** Publishes one ping to the organizer's live-check channel; throws with the reason when publishing does not work. */
  publishHealth?: (at: number) => Promise<void>;
  closeStreams?: (playerId: string) => Promise<void>;
  defer?: (work: Promise<unknown>) => void;
  /** Rate limiter; defaults to the KV-backed one (see throttle.ts). */
  throttle?: Throttle;
  /** Hosted: refuse plain HTTP (redirect pages, reject API calls) and always set Secure cookies. */
  requireHttps?: boolean;
  /** True only for requests Fanout forwarded (a valid Grip-Sig). */
  viaFanout?: (request: Request) => Promise<boolean>;
  /** Hands a live-stream request to Fanout (Compute: `createFanoutHandoff(request, 'self')`). */
  handoff?: (request: Request) => Response;
  /** Serves the hosted frontend for non-API paths. */
  assets?: (path: string) => Response | null;
  now?: () => number; iterations?: number;
  /** Randomness for sampled bookkeeping (tests pin it). */
  random?: () => number;
}

const security = {
  'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...security, ...headers } });
}
async function body(request: Request, limit = LIMIT): Promise<Record<string, unknown>> {
  // Refuse a declared size that cannot fit before reading anything (a character is at most 3 bytes).
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit * 3) throw new RoomError(413, 'Request is too large.');
  const text = await request.text();
  if (text.length > limit) throw new RoomError(413, 'Request is too large.');
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : {}; } catch { throw new RoomError(400, 'Send valid JSON.'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RoomError(400, 'Send a JSON object.');
  return parsed as Record<string, unknown>;
}
/** True for a well-formed session cookie: the only requests worth spending storage reads on. */
const hasSessionCookie = (request: Request) => new RegExp(`(?:^|;\\s*)${COOKIE}=[A-Za-z0-9_-]{43}(?:;|$)`).test(request.headers.get('cookie') ?? '');
function validDataset(value: unknown): value is Dataset {
  const d = value as Dataset;
  return !!d && Array.isArray(d.dates) && d.dates.every(date => typeof date === 'string') && Array.isArray(d.players) && d.players.length > 0
    && d.players.every(p => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.team === 'string' && typeof p.days === 'object' && p.days !== null)
    && new Set(d.players.map(p => p.id)).size === d.players.length;
}

/**
 * The whole hosted EdgeCanvas API as a Fetch-API handler, so it runs unchanged on Fastly Compute
 * (compute/src/main.ts) and in Node tests. Storage is KV only; live updates go through Fanout.
 */
export function createEdgeApp(options: EdgeAppOptions) {
  const { kv } = options;
  const now = options.now ?? Date.now;
  const throttle = options.throttle ?? createKvThrottle(kv, now);
  const once = <T>(source: T | (() => Promise<T>)) => { let value: Promise<T> | undefined; return () => value ??= Promise.resolve(typeof source === 'function' ? (source as () => Promise<T>)() : source); };
  const adminToken = once(options.adminToken);
  const pushReady = once(options.pushReady ?? (async () => !!options.publish));
  const pepper = once(options.pepper);
  const INK_TICKET_MS = 2 * 3600 * 1000;
  /** Marks a room view live (or not) and, when pushes work, hands the player a ticket for live drawing previews. */
  const withLive = async <T extends { code: string; state: { playerId: string; team: string } }>(view: T) => {
    const live = await pushReady();
    return { ...view, live, ...(live ? { ink: await issueInkTicket(await pepper(), { room: view.code, player: view.state.playerId, team: view.state.team, exp: now() + INK_TICKET_MS }) } : {}) };
  };
  let dataset: Dataset | null = null;
  async function loadDataset(): Promise<Dataset | null> {
    if (dataset) return dataset;
    const text = await kv.get(DATASET);
    if (text) dataset = JSON.parse(text) as Dataset;
    return dataset;
  }
  const authority = createEdgeAuthority({ kv, publish: options.publish, publishBatch: options.publishBatch, defer: options.defer,
    closeStreams: options.closeStreams && ((_room, player) => options.closeStreams!(player)) });
  const accounts = createEdgeAccounts({ kv, pepper, throttle, now: options.now, iterations: options.iterations,
    playerIds: async () => (await loadDataset())?.players.map(p => p.id) ?? [], onRevoke: options.closeStreams,
    playerInfo: async id => { const p = (await loadDataset())?.players.find(player => player.id === id); return p ? { name: p.name, team: p.team } : null; } });

  async function admin(request: Request, client: string) {
    await throttle.peek(`admin:${client}`, 10, 900);
    const supplied = /^Bearer (\S{32,256})$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
    const expected = await adminToken();
    // Compare digests so the check takes the same time whatever the supplied value.
    if (!expected || expected.length < 32 || await sha256(supplied) !== await sha256(expected)) {
      await throttle(`admin:${client}`, 10, 900).catch(() => {});
      throw new RoomError(401, 'Organizer token required.');
    }
  }
  /** Origin must name this very host; over HTTPS-only hosting it must also be https. */
  function sameOrigin(request: Request, url: URL) {
    try {
      const origin = new URL(request.headers.get('origin') ?? '');
      return origin.host === url.host && (origin.protocol === url.protocol || (!!options.requireHttps && origin.protocol === 'https:'));
    } catch { return false; }
  }

  async function route(request: Request, client: string): Promise<Response> {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    const secure = url.protocol === 'https:' || !!options.requireHttps;
    const cookies = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
    const token = cookies.length === 1 ? cookies[0].slice(COOKIE.length + 1) : '';
    const cookie = (value: string, age: number) => ({ 'set-cookie': `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}` });
    const emptyBody = async () => {
      const input = await body(request, 8192);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new RoomError(400, 'Send an empty request.');
    };

    // Organizer tooling (scripts/edge-admin.ts); authenticated by the Secret Store admin token.
    if (path === '/api/admin/dataset' && method === 'PUT') {
      await admin(request, client);
      const input = await body(request, DATASET_LIMIT);
      if (!validDataset(input)) throw new RoomError(400, 'Invalid dataset.');
      await kv.put(DATASET, JSON.stringify(input)); dataset = input;
      return json(200, { players: input.players.length, dates: input.dates.length });
    }
    // Live check for the organizer tool: a held stream plus a ping, so Fanout can be verified without any account or room.
    if (path === '/api/admin/events' && method === 'GET') {
      await admin(request, client);
      if (options.handoff && !(options.viaFanout && await options.viaFanout(request))) return options.handoff(request);
      return new Response('retry: 3000\n\n', { status: 200, headers: { ...security, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
        'grip-hold': 'stream', 'grip-channel': ADMIN_CHANNEL, 'grip-keep-alive': ': ping\\n\\n; format=cstring; timeout=20' } });
    }
    if (path === '/api/admin/ping' && method === 'POST') {
      await admin(request, client);
      if (!options.publishHealth) return json(409, { published: false, error: 'Live pushes are not configured.' });
      try { await options.publishHealth(Date.now()); return json(200, { published: true }); }
      catch (error) { return json(502, { published: false, error: error instanceof Error ? error.message : 'Publishing failed.' }); }
    }
    // A clean start: one new room (empty board, every wallet at zero, day 1) and the old ones leave everyone's lists. Accounts and step histories stay.
    if (path === '/api/admin/reset' && method === 'POST') {
      await admin(request, client);
      const input = await body(request, 8192) as { name?: unknown; hostId?: unknown };
      const data = await loadDataset();
      if (!data) throw new RoomError(409, 'Upload the roster before creating a room.');
      const room = await authority.createRoom({ name: typeof input.name === 'string' ? input.name : 'Splash', hostId: input.hostId as string, dataset: data }, { invites: false });
      return json(201, { code: room.code, retired: await authority.retireRoomsExcept(room.code) });
    }
    if (path === '/api/admin/enroll' && method === 'POST') {
      await admin(request, client);
      const input = await body(request) as { playerId?: unknown; organizer?: unknown };
      // `days` (1 to 7) lets an organizer hand out links that outlast a single day; the default stays 24 hours.
      const days = (input as { days?: unknown }).days;
      return json(201, await accounts.enroll(input.playerId as string, input.organizer === true, days === undefined ? undefined : Number.isInteger(days) ? (days as number) * 24 * 60 * 60000 : NaN));
    }

    if (method !== 'GET' && !sameOrigin(request, url)) throw new RoomError(403, 'Same-origin request required.');
    if (method === 'POST' && path === '/api/auth/recover') return json(200, await accounts.recover(await body(request, 8192), client));
    if (method === 'POST' && path === '/api/auth/enrollment') return json(200, await accounts.describeEnrollment(await body(request, 8192), client));
    if (method === 'POST' && (path === '/api/auth/register' || path === '/api/auth/login')) {
      const input = await body(request, 8192);
      const result = path.endsWith('/register') ? await accounts.register(input, client) : await accounts.login(input, client);
      if (token) await accounts.logout(token).catch(() => {});
      const { token: session, ...publicResult } = result;
      return json(path.endsWith('/register') ? 201 : 200, publicResult, cookie(session, ACCOUNT_SESSION_MS / 1000));
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      // A lost logout acknowledgment may already have cleared the browser cookie.
      if (!cookies.length) { await emptyBody(); return json(200, { signedOut: true }, cookie('', 0)); }
      if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !(await validCsrf(token, request.headers.get('x-csrf-token')))) throw new RoomError(403, 'Invalid request token.');
      await emptyBody(); await accounts.logout(token);
      return json(200, { signedOut: true }, cookie('', 0));
    }
    // Live drawing previews are the one call that must be fast, so they skip the account lookups: the signed ticket from the
    // player's room view says who they are and expires on its own. It only ever produces a visual preview.
    const ink = method === 'POST' ? /^\/api\/rooms\/([A-Z0-9]{12})\/ink$/.exec(path) : null;
    if (ink) {
      const claims = await readInkTicket(await pepper(), request.headers.get('x-ink-ticket'), now());
      if (!claims) throw new RoomError(403, 'Your preview ticket expired.');   // not 401: that would make the browser think its session ended
      if (claims.room !== ink[1]) throw new RoomError(403, 'This ticket is for another room.');
      // A read-only look at the player's budget gates the publish (about 200 previews per 10 seconds). Recording every use
      // would cost several storage operations each, so only one request in INK_SAMPLE is recorded, after answering.
      const gate = throttle.peek(`ink:${claims.player}`, INK_BUDGET, 10); gate.catch(() => {});
      await authority.ink(ink[1], claims, await body(request, 8192), gate);
      if ((options.random ?? Math.random)() < 1 / INK_SAMPLE) {
        const used = throttle(`ink:${claims.player}`, INK_BUDGET, 10).catch(() => {});
        if (options.defer) options.defer(used); else await used;
      }
      return json(200, { ok: true });
    }
    // Made-up (but well-formed) session cookies cost storage reads, so each network gets a small budget of them.
    // The budget is checked alongside the session lookup (not before it), so signed-in players pay no extra
    // round trip and a valid session is never refused because of other people's failures on the same network.
    const shaped = /^[A-Za-z0-9_-]{43}$/.test(token);
    const spent = shaped ? throttle.peek(`session:${client}`, SESSION_MISSES, 60).then(() => false, () => true) : Promise.resolve(false);
    let current: Awaited<ReturnType<typeof accounts.current>>;
    try { current = await accounts.current(token); }
    catch (error) {
      if (shaped && error instanceof RoomError && error.status === 401) {
        if (await spent) throw new RoomError(429, 'Too many attempts. Please wait a few minutes and try again.');
        await throttle(`session:${client}`, SESSION_MISSES, 60).catch(() => {});
      }
      throw error;
    }
    const player = current.account.playerId;
    if (method !== 'GET' && !(await validCsrf(token, request.headers.get('x-csrf-token')))) throw new RoomError(403, 'Invalid request token.');
    // Every signed-in player has their own budget, so one account cannot run up storage or publish costs.
    const limit = (scope: string, count: number, seconds: number) => throttle(`${scope}:${player}`, count, seconds);
    if (path === '/api/account' && method === 'GET') return json(200, current);
    if (path === '/api/admin/accounts' && method === 'GET') return json(200, await accounts.list(token));
    const recovery = /^\/api\/admin\/accounts\/([a-f0-9-]{36})\/(recovery|revoke-recovery|disable)$/.exec(path);
    if (recovery && method === 'POST') {
      await emptyBody();
      if (recovery[2] === 'recovery') return json(201, await accounts.issueRecovery(token, recovery[1]));
      if (recovery[2] === 'disable') { await accounts.disable(token, recovery[1]); return json(200, { disabled: true }); }
      await accounts.revokeRecovery(token, recovery[1]); return json(200, { revoked: true });
    }
    if (path === '/api/rooms' && method === 'GET') { await limit('list', 30, 60); return json(200, await authority.rooms(player)); }
    if (path === '/api/rooms' && method === 'POST') {
      await accounts.requireOrganizer(token);
      await limit('room-create', 5, 3600);
      const input = await body(request, 8192) as { name?: unknown };
      const data = await loadDataset();
      if (!data) throw new RoomError(409, 'Upload the roster before creating a room.');
      const room = await authority.createRoom({ name: input.name as string, hostId: player, dataset: data }, { invites: false });
      return json(201, await withLive(await authority.enter(room.code, player)));
    }
    const room = /^\/api\/rooms\/([A-Z0-9]{12})(?:\/(join|commands|events|schedule))?$/.exec(path);
    if (room) {
      const [, code, action] = room;
      if (action === 'join' && method === 'POST') { await emptyBody(); await limit('view', 30, 60); return json(200, await withLive(await authority.enter(code, player))); }
      if (action === 'commands' && method === 'POST') {
        // The limit runs alongside the reads; commandAs waits for it before writing anything, and a refused move answers 429.
        const gate = limit('command', 40, 10); gate.catch(() => {});
        // Version hints from the client are ignored: a hostile value would only force slow reads.
        const reply = await authority.commandAs(code, player, await body(request), {}, gate);
        await gate;
        return json(200, reply);
      }
      if (action === 'schedule' && method === 'POST') {
        await limit('command', 40, 10);
        return json(200, await withLive(await authority.setSchedule(code, player, await body(request, 512) as { at: number | null })));
      }
      if (action === 'events' && method === 'GET') {
        await limit('subscribe', 12, 60);
        await authority.member(code, player);
        return new Response('retry: 3000\n\n', { status: 200, headers: { ...security, ...(await gripHoldHeaders(code, player)) } });
      }
      if (!action && method === 'GET') { await limit('view', 30, 60); return json(200, await withLive(await authority.viewAs(code, player))); }
    }
    throw new RoomError(404, 'Route not found.');
  }

  return {
    authority, accounts,
    async handle(request: Request, client = 'unknown'): Promise<Response> {
      const url = new URL(request.url);
      if (options.requireHttps && url.protocol !== 'https:' && !(options.viaFanout && await options.viaFanout(request))) {
        if (request.method === 'GET' || request.method === 'HEAD') return new Response(null, { status: 301, headers: { ...security, location: `https://${url.host}${url.pathname}${url.search}` } });
        return json(400, { error: 'Use HTTPS.' });
      }
      client = clientKey(client);
      if (!url.pathname.startsWith('/api/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'Method not allowed.' });
        return options.assets?.(url.pathname) ?? json(404, { error: 'Not found.' });
      }
      // Live streams: Fanout forwards the browser's request back to this service with a Grip-Sig.
      if (/^\/api\/rooms\/[A-Z0-9]{12}\/events$/.test(url.pathname) && request.method === 'GET' && options.handoff
        && !(options.viaFanout && await options.viaFanout(request))) {
        // Only a request that at least carries a session cookie is worth two invocations and a Fanout connection.
        return hasSessionCookie(request) ? options.handoff(request) : json(401, { error: 'Sign in to continue.' });
      }
      try { return await route(request, client); }
      catch (error) {
        if (error instanceof RoomError) return json(error.status, { error: error.message });
        console.error('Unhandled request error', error instanceof Error ? error.message : 'unknown');
        return json(500, { error: 'Something went wrong. Please retry.' });
      }
    },
  };
}
