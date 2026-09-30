/// <reference types="@fastly/js-compute" />
// EdgeCanvas on Fastly Compute alone: the API, accounts and room state live in this service and
// its KV Store; Fanout holds the live streams. There is no origin server (docs/decisions/room-storage.md).
import { env } from 'fastly:env';
import { createFanoutHandoff } from 'fastly:fanout';
import { KVStore } from 'fastly:kv-store';
import { SecretStore } from 'fastly:secret-store';
import { createEdgeApp } from '../../src/edge/app';
import { edgeGripVerifier, edgePublisher, FASTLY_GRIP_JWK } from '../../src/edge/grip';
import type { EdgeKV } from '../../src/edge/kv';
import { assets } from '../build/assets.js';

const STORE = 'edgecanvas', SECRETS = 'edgecanvas_secrets';

/** Maps the authority's KV surface onto Fastly KV Store. Only `add` must be atomic. */
function fastlyKV(store: KVStore): EdgeKV {
  return {
    async get(key) { const entry = await store.get(key); return entry ? entry.text() : null; },
    async add(key, value, options) {
      try { await store.put(key, value, { mode: 'add', ...(options?.ttl ? { ttl: options.ttl } : {}) }); return true; }
      catch (error) {
        // The real service reports a lost race as "KVStore insert: Precondition failed" (checked September 29, 2026:
        // exactly one of 16 simultaneous inserts wins, the rest fail this way). Anything else is a real failure.
        if (/precondition failed/i.test(String((error as Error)?.message ?? error))) return false;
        throw error;
      }
    },
    async put(key, value) { await store.put(key, value); },
    async delete(key) { await store.delete(key); },
    async list(prefix) {
      const keys: string[] = []; let cursor: string | undefined;
      // Prefixes must not contain "/" or ":" (the service answers 400); the key builders keep listable families free of them.
      do { const page = await store.list(cursor ? { prefix, cursor } : { prefix }); keys.push(...page.list); cursor = page.cursor; } while (cursor);
      return keys;
    },
  };
}

const local = () => env('FASTLY_HOSTNAME') === 'localhost';
let app: ReturnType<typeof createEdgeApp> | undefined;
let pending: Promise<unknown>[] = [];

/** Secrets are read only by the routes that need them: each read is a remote call on a cold instance. */
async function secret(name: string) { return (await new SecretStore(SECRETS).get(name))?.plaintext() ?? ''; }
function build() {
  const serviceId = env('FASTLY_SERVICE_ID');
  let apiToken: Promise<string> | undefined, verifier: ((header: string | null) => Promise<boolean>) | undefined;
  // Hosted: Fastly's publish API. Local: the Pushpin that Viceroy starts next to it.
  const send = async (items: unknown[]) => {
    const token = local() ? '' : await (apiToken ??= secret('fanout_api_token'));
    if (!local() && !token) throw new Error('The Fanout publish token (fanout_api_token) is not set in the Secret Store.');
    const response = local()
      ? await fetch('http://127.0.0.1:5561/publish/', { method: 'POST', body: JSON.stringify({ items }), backend: 'pushpin_publish' })
      : await fetch(`https://api.fastly.com/service/${serviceId}/publish/`, { method: 'POST', body: JSON.stringify({ items }), backend: 'fanout_publish',
        headers: { 'content-type': 'application/json', 'fastly-key': token } });
    if (!response.ok) throw new Error(`GRIP publish failed with HTTP ${response.status}`);
  };
  const publisher = edgePublisher(send);
  return createEdgeApp({
    kv: fastlyKV(new KVStore(STORE)),
    adminToken: () => secret('admin_token'),
    pepper: async () => {
      const pepper = await secret('password_pepper');
      if (pepper.length < 32) throw new Error('Configure password_pepper in the Secret Store.');
      return pepper;
    },
    publish: publisher.publish, publishBatch: publisher.publishBatch, publishHealth: publisher.publishHealth, closeStreams: publisher.closeStreams,
    defer: work => { pending.push(work); },
    // Rate limits live in KV (src/edge/throttle.ts): global, testable locally and not dependent on an add-on.
    requireHttps: !local(),
    // Live pushes need the Fanout publish token; without it browsers fall back to polling.
    pushReady: async () => local() || (await secret('fanout_api_token')).length > 0,
    viaFanout: async request => {
      verifier ??= local() ? edgeGripVerifier({ secret: await secret('local_grip_key') }) : edgeGripVerifier({ jwk: FASTLY_GRIP_JWK, issuer: `fastly:${serviceId}` });
      return verifier(request.headers.get('grip-sig'));
    },
    handoff: request => createFanoutHandoff(request, 'self'),
    assets: path => assets(path),
  });
}

addEventListener('fetch', event => event.respondWith((async () => {
  app ??= build();
  const response = await app.handle(event.request, event.client.address);
  // Best-effort hints (heads, wallet version) finish after the response is sent.
  const work = pending; pending = [];
  if (work.length) event.waitUntil(Promise.allSettled(work));
  return response;
})()));
