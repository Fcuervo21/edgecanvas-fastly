import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RoomService } from './service';
import type { RoomCommand } from '../src/rooms/types';
import { ACCOUNT_SESSION_MS, validCsrf } from './auth';
import { RoomError } from './errors';
import { serveRoomEvents, streamStart } from './stream';

const COOKIE = 'edgecanvas_account';
export async function handleAccountRequest(request: IncomingMessage, response: ServerResponse, url: URL,
  accounts: NonNullable<RoomService['accounts']>,
  jsonBody: (request: IncomingMessage, limit?: number) => Promise<unknown>,
  send: (response: ServerResponse, status: number, body: unknown) => void, secure: boolean,
  watch: (code: string, listener: () => void) => () => void = () => () => {}, heartbeatMs?: number, viaFanout = false) {
  const cookies = (request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
  const token = cookies.length === 1 ? cookies[0].slice(COOKIE.length + 1) : '';
  const path = url.pathname, method = request.method;
  const cookie = (value: string, age: number) => response.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`);
  const emptyBody = async () => {
    const body = await jsonBody(request, 8192);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new RoomError(400, 'Send an empty request.');
  };
  if (method !== 'GET' && request.headers.origin !== url.origin) throw new RoomError(403, 'Same-origin request required.');
  if (method === 'POST' && path === '/api/auth/recover') {
    return send(response, 200, await accounts.recover(await jsonBody(request, 8192), request.socket.remoteAddress ?? 'unknown'));
  }
  if (method === 'POST' && (path === '/api/auth/register' || path === '/api/auth/login')) {
    const input = await jsonBody(request, 8192), client = request.socket.remoteAddress ?? 'unknown';
    const result = path.endsWith('/register') ? await accounts.register(input, client) : await accounts.login(input, client);
    if (token) accounts.logout(token);
    cookie(result.token, ACCOUNT_SESSION_MS / 1000);
    const { token: _secret, ...publicResult } = result;
    return send(response, path.endsWith('/register') ? 201 : 200, publicResult);
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    // A lost logout acknowledgment may already have cleared the browser cookie.
    if (!cookies.length) { await emptyBody(); cookie('', 0); return send(response, 200, { signedOut: true }); }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !validCsrf(token, request.headers['x-csrf-token'])) throw new RoomError(403, 'Invalid request token.');
    await emptyBody(); accounts.logout(token); cookie('', 0);
    return send(response, 200, { signedOut: true });
  }
  const current = accounts.current(token);
  if (method !== 'GET' && !validCsrf(token, request.headers['x-csrf-token'])) throw new RoomError(403, 'Invalid request token.');
  if (path === '/api/account' && method === 'GET') return send(response, 200, current);
  if (path === '/api/roster' && method === 'GET') return send(response, 200, accounts.roster(token));
  if (path === '/api/admin/accounts' && method === 'GET') return send(response, 200, accounts.list(token));
  const recovery = /^\/api\/admin\/accounts\/([a-f0-9-]{36})\/(recovery|revoke-recovery)$/.exec(path);
  if (recovery && method === 'POST') {
    await emptyBody();
    if (recovery[2] === 'recovery') return send(response, 201, accounts.issueRecovery(token, recovery[1]));
    accounts.revokeRecovery(token, recovery[1]); return send(response, 200, { revoked: true });
  }
  const disable = /^\/api\/admin\/accounts\/([a-f0-9-]{36})\/disable$/.exec(path);
  if (disable && method === 'POST') { await emptyBody(); accounts.disable(token, disable[1]); return send(response, 200, { disabled: true }); }
  if (path === '/api/rooms') {
    if (method === 'GET') return send(response, 200, accounts.listRooms(token));
    if (method === 'POST') return send(response, 201, accounts.createRoom(token, await jsonBody(request, 8192)));
  }
  const room = /^\/api\/rooms\/([A-Z0-9]{12})(?:\/(join|commands|events))?$/.exec(path);
  if (room) {
    const [, code, action] = room;
    if (action === 'join' && method === 'POST') { await emptyBody(); return send(response, 200, accounts.joinRoom(token, code)); }
    if (action === 'events' && method === 'GET') {
      return serveRoomEvents(request, response, streamStart(request, url), after => accounts.eventsRoom(token, code, after),
        listener => watch(code, listener), heartbeatMs, viaFanout ? { code, playerId: current.account.playerId } : undefined);
    }
    if (action === 'commands' && method === 'POST') return send(response, 200, accounts.commandRoom(token, code, await jsonBody(request) as RoomCommand));
    if (!action && method === 'GET') {
      const value = url.searchParams.get('after');
      const after = value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
      return send(response, 200, accounts.viewRoom(token, code, after));
    }
  }
  throw new RoomError(404, 'Route not found.');
}
