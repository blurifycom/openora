export type TtlCacheOptions = {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
};

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

  pending(key: string): Promise<P> | undefined {
    return this.inFlight.get(key);
  }

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

  clearPending(): void {
    this.inFlight.clear();
  }
}
