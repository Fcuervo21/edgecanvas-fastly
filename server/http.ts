import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { handleAccountRequest } from './account-http';
import type { RoomCommand } from '../src/rooms/types';
import { RoomError, type RoomService } from './service';
import { serveRoomEvents, streamStart } from './stream';
import type { GripVerifier } from './grip';

const JSON_LIMIT = 256 * 1024;
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' };
function localOrigin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.origin === value; }
  catch { return false; }
}
async function jsonBody(request: IncomingMessage, limit = JSON_LIMIT): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new RoomError(415, 'Send application/json.');
  if (Number(request.headers['content-length']) > limit) { request.resume(); throw new RoomError(413, 'Request body is too large.'); }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= limit) chunks.push(Buffer.from(chunk));
  }
  if (size > limit) throw new RoomError(413, 'Request body is too large.');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RoomError(400, 'Invalid JSON.'); }
}
function send(response: ServerResponse, status: number, body: unknown) {
  const data = Buffer.from(JSON.stringify(body));
  // An explicit length avoids chunked re-encoding problems in GRIP proxies (seen with Pushpin 1.38).
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': data.length });
  response.end(data);
}
export function createRoomServer(options: { service: RoomService; distDir?: string; allowedOrigins?: string[]; secureCookies?: boolean; heartbeatMs?: number;
  /** Recognizes requests forwarded by Fanout; without it every stream is served directly. */
  fanout?: GripVerifier }) {
  const root = resolve(options.distDir ?? (options.service.accounts ? 'dist-hosted' : 'dist'));
  const extraOrigins = options.allowedOrigins ?? [];
  if (extraOrigins.some(origin => !localOrigin(origin))) throw new Error('Additional origins must be HTTP loopback origins.');
  return createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    response.setHeader('x-frame-options', 'DENY');
    try {
      const port = request.socket.localPort;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(request.headers.host ?? '')) throw new RoomError(403, 'Loopback Host required.');
      const origin = request.headers.origin;
      if (origin && ![...hosts.map(host => `http://${host}`), ...extraOrigins].includes(origin)) throw new RoomError(403, 'Origin is not allowed.');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new RoomError(403, 'Cross-site requests are not allowed.');
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      const pathname = url.pathname;
      if (pathname.startsWith('/api/') && options.service.accounts) return await handleAccountRequest(request, response, url, options.service.accounts, jsonBody, send, options.secureCookies !== false,
        (code, listener) => options.service.watch(code, listener), options.heartbeatMs, !!options.fanout?.(request.headers['grip-sig']));
      const token = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
      if (pathname === '/api/roster' && request.method === 'GET') return send(response, 200, options.service.roster());
      if (pathname === '/api/rooms' && request.method === 'POST') {
        const body = await jsonBody(request);
        return send(response, 201, options.service.create(body as { name: string; hostId: string }));
      }
      const roomRoute = /^\/api\/rooms\/([A-Z0-9]{12})(?:\/(join|commands|invites|logout|events))?$/.exec(pathname);
      if (roomRoute) {
        const [, code, action] = roomRoute;
        if (action === 'logout' && request.method === 'POST') {
          const body = await jsonBody(request);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new RoomError(400, 'Send an empty logout request.');
          options.service.logout(code, token);
          return send(response, 200, { signedOut: true });
        }
        if (action === 'join' && request.method === 'POST') return send(response, 200, options.service.join(code, await jsonBody(request) as { inviteCode: string }));
        if (action === 'commands' && request.method === 'POST') return send(response, 200, options.service.command(code, token, await jsonBody(request) as RoomCommand));
        if (action === 'events' && request.method === 'GET') {
          const fanout = options.fanout?.(request.headers['grip-sig']) ? { code, playerId: options.service.player(code, token) } : undefined;
          return serveRoomEvents(request, response, streamStart(request, url), after => options.service.events(code, token, after),
            listener => options.service.watch(code, listener), options.heartbeatMs, fanout);
        }
        if (action === 'invites' && request.method === 'GET') return send(response, 200, options.service.invites(code, token));
        if (!action && request.method === 'GET') {
          const value = url.searchParams.get('after');
          const after = value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
          return send(response, 200, options.service.view(code, token, after));
        }
      }
      if (pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method ?? '')) throw new RoomError(404, 'Route not found.');
      let decoded: string;
      try { decoded = decodeURIComponent(pathname); } catch { throw new RoomError(404, 'File not found.'); }
      if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) throw new RoomError(404, 'File not found.');
      const path = resolve(root, decoded === '/' ? 'index.html' : `.${decoded}`);
      let actual: string; let actualRoot: string;
      try { [actual, actualRoot] = await Promise.all([realpath(path), realpath(root)]); }
      catch { throw new RoomError(404, 'File not found.'); }
      const rel = relative(actualRoot, actual);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new RoomError(404, 'File not found.');
      if (!(await stat(actual)).isFile()) throw new RoomError(404, 'File not found.');
      const data = await readFile(actual);
      response.writeHead(200, { 'content-type': MIME[extname(actual)] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'content-length': data.length });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (!response.headersSent) send(response, error instanceof RoomError ? error.status : 500,
        { error: error instanceof RoomError ? error.message : 'The room server could not complete this request.' });
      else response.end();
    }
  });
}
