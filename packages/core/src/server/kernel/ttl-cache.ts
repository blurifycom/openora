export type TtlCacheOptions = {
  ttlMs: number;
  /** Past this many live entries the oldest is dropped, so a read it served is only asked again. */
  maxEntries: number;
  now?: () => number;
};

/**
 * A small per-process cache: entries expire after `ttlMs`, the oldest goes first past
 * `maxEntries`, and calls in flight for a key are shared so a burst of parallel reads makes one
 * call. For a process that reads another service and can live with an answer a few seconds old;
 * move it to the shared CACHE port when replicas need one view.
 *
 * `V` is what is kept, `P` what a call in flight resolves to (a batched call answers many keys).
 */
export class TtlCache<V, P = V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<P>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor({ ttlMs, maxEntries, now = Date.now }: TtlCacheOptions) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  deleteWhere(matches: (value: V) => boolean): void {
    for (const [key, { value }] of this.entries) {
      if (matches(value)) {
        this.entries.delete(key);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** The call in flight for `key`, to join instead of starting another. */
  pending(key: string): Promise<P> | undefined {
    return this.inFlight.get(key);
  }

  /** Registers `call` as the one in flight for `keys` until it settles. */
  track(keys: readonly string[], call: Promise<P>): void {
    for (const key of keys) {
      this.inFlight.set(key, call);
    }
    const settle = () => {
      for (const key of keys) {
        if (this.inFlight.get(key) === call) {
          this.inFlight.delete(key);
        }
      }
    };
    call.then(settle, settle);
  }

  /** Forgets every call in flight: the next read starts its own, so it cannot join a stale one. */
  clearPending(): void {
    this.inFlight.clear();
  }
}
