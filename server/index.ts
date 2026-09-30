import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSteps } from '../src/data/steps';
import { createRoomService } from './service';
import { createRoomServer } from './http';
import { FASTLY_GRIP_PUBLIC_KEY, gripPublisher, gripVerifier } from './grip';

const root = resolve(import.meta.dirname, '..');
const csv = readdirSync(resolve(root, 'StepsData')).find(name => name.endsWith('.csv'));
if (!csv) throw new Error('The CSV roster is missing.');
const accountMode = process.env.ROOM_ACCESS_MODE === 'accounts';
if (process.env.ROOM_ACCESS_MODE && !['local', 'accounts'].includes(process.env.ROOM_ACCESS_MODE)) throw new Error('Unknown ROOM_ACCESS_MODE.');
const port = Number(process.env.PORT ?? (accountMode ? 4180 : 4173));
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
// Optional Fanout/Pushpin integration (M4). Secrets come only from the environment and are never logged.
const publisher = process.env.FANOUT_PUBLISH_URL ? gripPublisher({ endpoint: process.env.FANOUT_PUBLISH_URL, token: process.env.FASTLY_API_TOKEN }) : undefined;
const fanout = process.env.FANOUT_GRIP_ISSUER ? gripVerifier({ issuer: process.env.FANOUT_GRIP_ISSUER,
  ...(process.env.FANOUT_GRIP_SECRET ? { secret: process.env.FANOUT_GRIP_SECRET } : { publicKey: FASTLY_GRIP_PUBLIC_KEY }) }) : undefined;
if (fanout && !publisher) throw new Error('FANOUT_GRIP_ISSUER requires FANOUT_PUBLISH_URL so held streams receive events.');
const service = createRoomService({ dataset: parseSteps(readFileSync(resolve(root, 'StepsData', csv), 'utf8')),
  accessMode: accountMode ? 'accounts' : 'local', ...publisher,
  databasePath: resolve(root, accountMode ? '.local/accounts-rooms.sqlite' : '.local/rooms.sqlite') });
const server = createRoomServer({ service, distDir: resolve(root, accountMode ? 'dist-hosted' : 'dist'),
  // Explicit HTTP loopback development profile; hosting must use Secure cookies over TLS.
  secureCookies: false,
  allowedOrigins: process.env.ROOM_DEV_ORIGIN ? [process.env.ROOM_DEV_ORIGIN] : [], fanout });
// Retry publications that failed after commit; a new commit also triggers a drain.
if (publisher) setInterval(() => { void service.flushOutbox(); }, 5000).unref();
server.listen(port, '127.0.0.1', () => { console.log(`Local ${accountMode ? 'account' : 'room'} lobby: http://127.0.0.1:${port}/${accountMode ? '' : '?mode=rooms'}`); });
const stop = () => {
  server.close(() => { service.close(); process.exit(0); }); server.closeIdleConnections();
  // Live room streams never become idle; give in-flight commands a moment, then close them.
  setTimeout(() => server.closeAllConnections(), 2000).unref();
};
process.on('SIGINT', stop); process.on('SIGTERM', stop);
