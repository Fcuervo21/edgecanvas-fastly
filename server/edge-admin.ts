import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseSteps } from '../src/data/steps';

// Organizer tooling for the all-Fastly deployment. The admin token is read from the environment
// (EDGE_ADMIN_TOKEN) and never printed; the roster CSV stays on this computer and only its parsed
// dataset is uploaded to the service's private KV Store.
const usage = `Usage:
  EDGE_ADMIN_TOKEN=… npm run edge:admin -- upload --url https://your-service.example
  EDGE_ADMIN_TOKEN=… npm run edge:admin -- enroll --url https://your-service.example --player "EXACT_ROSTER_PLAYER_ID" [--organizer] [--days 1-7]
  EDGE_ADMIN_TOKEN=… npm run edge:admin -- links --url https://your-service.example [--days 1-7] [--organizer "EXACT_ROSTER_PLAYER_ID"]   (personal links for everyone without an account)
  EDGE_ADMIN_TOKEN=… npm run edge:admin -- reset --url https://your-service.example --host "EXACT_ROSTER_PLAYER_ID" [--name Splash]   (a clean start: new empty room, old rooms leave everyone's lists; accounts and roster stay)
  EDGE_ADMIN_TOKEN=… npm run edge:admin -- live --url https://your-service.example [--count 10]   (checks Fanout end to end: opens a held stream, publishes pings, measures delivery)
Local Viceroy: use --url http://127.0.0.1:7676 and the token in compute/.secrets/admin_token.`;
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const [action] = args, base = option('--url'), token = process.env.EDGE_ADMIN_TOKEN;
if (!action || args.includes('--help') || !['upload', 'enroll', 'links', 'live', 'reset'].includes(action) || !base) { console.log(usage); process.exit(action ? 1 : 0); }
const url = new URL(base!);
if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Use HTTPS outside loopback.');
if (!token || token.length < 32) throw new Error('Set EDGE_ADMIN_TOKEN to the service admin token.');
const root = resolve(import.meta.dirname, '..');
async function send(method: string, path: string, body: unknown) {
  const response = await fetch(new URL(path, url), { method, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error ?? 'request failed'}`);
  return data;
}
if (action === 'upload') {
  const csv = readdirSync(resolve(root, 'StepsData')).find(name => name.endsWith('.csv'));
  if (!csv) throw new Error('The roster is missing.');
  const result = await send('PUT', '/api/admin/dataset', parseSteps(readFileSync(resolve(root, 'StepsData', csv), 'utf8')));
  console.log(`Uploaded ${result.players} players and ${result.dates} dates.`);
} else if (action === 'live') {
  // Fanout check that needs no account: hold the organizer stream, publish pings and time how long each takes to arrive.
  const count = Math.max(1, Math.min(50, Number(option('--count') ?? 10)));
  const headers = { authorization: `Bearer ${token}` }, controller = new AbortController();
  const stream = await fetch(new URL('/api/admin/events', url), { headers, signal: controller.signal });
  if (!stream.ok || !stream.headers.get('content-type')?.includes('text/event-stream')) { console.log(`The live stream did not open (HTTP ${stream.status}).`); process.exit(1); }
  console.log('Live stream open, held by Fanout.');
  const waiting: (() => void)[] = [];
  void (async () => {
    const reader = stream.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      const parts = (buffer += decoder.decode(value, { stream: true })).split('\n\n'); buffer = parts.pop()!;
      for (const part of parts) if (/^event: ping/m.test(part)) waiting.shift()?.();
    }
  })().catch(() => {});
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const arrived = new Promise<number>(resolve => waiting.push(() => resolve(performance.now())));
    const started = performance.now();
    const ping = await fetch(new URL('/api/admin/ping', url), { method: 'POST', headers });
    const result = await ping.json() as { published?: boolean; error?: string };
    if (!ping.ok) { console.log(`Live pushes do NOT work yet: ${result.error ?? `HTTP ${ping.status}`}`); controller.abort(); process.exit(1); }
    const at = await Promise.race([arrived, new Promise<null>(resolve => setTimeout(() => resolve(null), 10000))]);
    if (at === null) { console.log('Published, but the ping never reached the stream within 10 seconds.'); controller.abort(); process.exit(1); }
    times.push(at - started);
  }
  const sorted = [...times].sort((a, b) => a - b), pick = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  console.log(`Live pushes work: ${count} of ${count} pings delivered. Publish-to-visible from this computer: p50 ${pick(0.5)} ms, p95 ${pick(0.95)} ms, max ${Math.round(sorted.at(-1)!)} ms.`);
  controller.abort();
} else if (action === 'reset') {
  const host = option('--host');
  if (!host) throw new Error('Pass --host with the exact roster player ID of the room host.');
  const result = await send('POST', '/api/admin/reset', { hostId: host, ...(option('--name') ? { name: option('--name') } : {}) });
  console.log(`Fresh room ${result.code} is open (day 1, empty board, every wallet at zero). ${result.retired} earlier room(s) retired.`);
} else if (action === 'links') {
  // One personal link per roster player who has no account yet: opening it fills in the code and greets them by name.
  // Reissuing replaces an earlier unused code. The fragment (#code=) is never sent to any server.
  const days = Number(option('--days') ?? 7);
  const csv = readdirSync(resolve(root, 'StepsData')).find(name => name.endsWith('.csv'));
  if (!csv) throw new Error('The roster is missing.');
  const organizers = args.flatMap((arg, i) => arg === '--organizer' ? [args[i + 1]] : []);
  const rows: string[] = ['name,team,role,link']; let skipped = 0;
  for (const player of parseSteps(readFileSync(resolve(root, 'StepsData', csv), 'utf8')).players) {
    try {
      const enrollment = await send('POST', '/api/admin/enroll', { playerId: player.id, days, organizer: organizers.includes(player.id) });
      rows.push([player.name, player.team, organizers.includes(player.id) ? 'Organizer' : 'Member', `${url.origin}/#code=${enrollment.code}`].map(cell => `"${cell.replaceAll('"', '""')}"`).join(','));
    } catch (error) { if (error instanceof Error && error.message.startsWith('409')) skipped++; else throw error; }
  }
  mkdirSync(resolve(root, '.local'), { recursive: true });
  const file = resolve(root, '.local', `personal-links-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}.csv`);
  writeFileSync(file, rows.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Personal links for ${rows.length - 1} players (${skipped} already have an account). Saved to ${file}`);
} else {
  const player = option('--player');
  if (!player) throw new Error('Pass --player with an exact roster player ID.');
  const days = option('--days');
  const enrollment = await send('POST', '/api/admin/enroll', { playerId: player, organizer: args.includes('--organizer'), ...(days ? { days: Number(days) } : {}) });
  mkdirSync(resolve(root, '.local'), { recursive: true });
  const file = resolve(root, '.local', `edge-enrollment-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(enrollment, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(`Private enrollment saved to ${file}`);
}
