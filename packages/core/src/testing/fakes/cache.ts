import type { CacheAdapter } from '@openora/core/contracts';

const SWEEP_INTERVAL_MS = 60_000;
// ponytail: hard cap bounds memory against unbounded key growth (eg per-slug churn);
// eviction is oldest-insert (Map iteration order), not LRU - swap for an LRU if
// hit-rate under heavy key churn ever matters.
const MAX_ENTRIES = 5_000;

type Entry = { value: unknown; expiresAt: number };

// Zero-dependency test-only double for `CACHE` (production auto-binds RedisCache on
// REDIS_URL - see `assertDurableSeamsBound`). Expiry is lazy (checked on access) plus
// an unref'd sweep so keys never revisited don't accumulate.
export class InProcessCache implements CacheAdapter {
  private readonly entries = new Map<string, Entry>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry) {
      return Promise.resolve(undefined);
    }
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value as T);
  }

  set<T>(key: string, value: T, opts: { ttlMs: number }): Promise<void> {
    if (!this.entries.has(key) && this.entries.size >= MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, { value, expiresAt: Date.now() + opts.ttlMs });
    return Promise.resolve();
  }

  delete(key: string | string[]): Promise<void> {
    for (const k of Array.isArray(key) ? key : [key]) {
      this.entries.delete(k);
    }
    return Promise.resolve();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }

  close(): void {
    clearInterval(this.sweeper);
    this.entries.clear();
  }
}
