// Bounded cache for upstream responses.
//  - fresh window: serve without calling upstream (protects the free public API)
//  - stale window: only used as a fallback when the upstream fails ("stale-if-error")
//  - single flight: concurrent misses for the same key share one upstream call (no dogpile)
//  - bounded size with LRU eviction so memory cannot grow without limit

export interface CacheEntry<V> {
  readonly value: V;
  readonly storedAt: number;
}

export class ResponseCache<V> {
  private readonly entries = new Map<string, CacheEntry<V>>();
  private readonly inFlight = new Map<string, Promise<V>>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {
    if (maxEntries < 1) throw new Error('maxEntries must be >= 1');
  }

  getFresh(key: string, freshMs: number): CacheEntry<V> | null {
    const e = this.entries.get(key);
    if (!e || this.now() - e.storedAt > freshMs) return null;
    this.touch(key, e);
    return e;
  }

  getStale(key: string, staleMs: number): CacheEntry<V> | null {
    const e = this.entries.get(key);
    if (!e || this.now() - e.storedAt > staleMs) return null;
    return e;
  }

  set(key: string, value: V, storedAt = this.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Runs `load` once per key at a time; parallel callers await the same promise. */
  singleFlight(key: string, load: () => Promise<V>): Promise<V> {
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = load().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  get size(): number {
    return this.entries.size;
  }

  private touch(key: string, e: CacheEntry<V>): void {
    this.entries.delete(key);
    this.entries.set(key, e);
  }
}
