/**
 * The small key-value surface the edge authority needs. The Fastly adapter maps it onto
 * `fastly:kv-store`; tests use {@link MemoryKV}. Correctness relies only on `add` being an
 * atomic insert-if-absent: every authoritative record is a new, write-once, versioned key,
 * so no key is ever rewritten (and the per-key write-rate limit never applies).
 */
export interface EdgeKV {
  get(key: string): Promise<string | null>;
  /** Inserts only if absent. Resolves `false` when the key already exists. `ttl` (seconds) lets the store expire it. */
  add(key: string, value: string, options?: { ttl?: number }): Promise<boolean>;
  /** Last-write-wins write for best-effort hints only; may fail under rate limiting. */
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** In-memory store with optional stale reads, to exercise eventual consistency in tests. */
export class MemoryKV implements EdgeKV {
  readonly data = new Map<string, string>();
  writes = 0;
  /** Lookups and listings, so tests can bound how much work a request causes. */
  reads = 0;
  lists = 0;
  /** Clock for expiring keys added with a `ttl`. */
  now: () => number = Date.now;
  private expiry = new Map<string, number>();
  /** Inserts refused because the key existed (write races). */
  conflicts = 0;
  /** Probability that `get` pretends a key added less than `staleMs` ago is not visible yet. */
  staleness = 0;
  staleMs = 40;
  private recent = new Map<string, number>();
  constructor(private random: () => number = Math.random, private delay: () => Promise<void> = () => Promise.resolve()) {}
  private purge() {
    const now = this.now();
    for (const [key, at] of this.expiry) if (at <= now) { this.expiry.delete(key); this.data.delete(key); }
  }
  async get(key: string) {
    await this.delay(); this.reads++; this.purge();
    const added = this.recent.get(key);
    if (added !== undefined && Date.now() - added < this.staleMs && this.random() < this.staleness) return null;
    return this.data.get(key) ?? null;
  }
  async add(key: string, value: string, options: { ttl?: number } = {}) {
    await this.delay(); this.purge();
    if (this.data.has(key)) { this.conflicts++; return false; }
    this.data.set(key, value); this.writes++;
    if (options.ttl) this.expiry.set(key, this.now() + options.ttl * 1000);
    this.recent.set(key, Date.now());
    return true;
  }
  async put(key: string, value: string) { await this.delay(); this.data.set(key, value); this.expiry.delete(key); this.writes++; }
  async delete(key: string) { await this.delay(); this.data.delete(key); this.expiry.delete(key); this.writes++; }
  async list(prefix: string) {
    // The real KV Store answers 400 to a listing prefix containing "/" or ":" (verified September 29, 2026), so listable key
    // families must use other separators. Mirrored here so tests cannot pass with a prefix the platform refuses.
    if (/[/:]/.test(prefix)) throw new TypeError('KVStore list: Bad request.');
    await this.delay(); this.reads++; this.lists++; this.purge(); return [...this.data.keys()].filter(key => key.startsWith(prefix)).sort();
  }
  /** Makes every existing key consistently visible. */
  settle() { this.recent.clear(); }
}

/**
 * Finds the newest existing version of a write-once versioned record, at or after `hint` (which
 * must exist or be 0), by galloping then bisecting. Version 0 means "no record yet".
 */
export async function newestVersion(kv: EdgeKV, at: (n: number) => string, hint = 0): Promise<number> {
  const exists = async (n: number) => (await kv.get(at(n))) !== null;
  let low = Math.max(0, hint), step = 1, high = low + 1;
  while (await exists(high)) { low = high; step *= 2; high = low + step; }
  while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (await exists(mid)) low = mid; else high = mid; }
  return low;
}
