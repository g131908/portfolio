// Minimal, bounded in-process metrics so failures are visible without external tooling.

const SAMPLE_WINDOW = 200;

export interface DependencyStats {
  readonly dependency: string;
  readonly requests: number;
  readonly failures: number;
  readonly retries: number;
  readonly staleServed: number;
  readonly cacheHits: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly lastError: string | null;
}

interface Mutable {
  requests: number;
  failures: number;
  retries: number;
  staleServed: number;
  cacheHits: number;
  latencies: number[];
  lastError: string | null;
}

export class Metrics {
  private readonly deps = new Map<string, Mutable>();

  private of(dep: string): Mutable {
    let m = this.deps.get(dep);
    if (!m) {
      m = { requests: 0, failures: 0, retries: 0, staleServed: 0, cacheHits: 0, latencies: [], lastError: null };
      this.deps.set(dep, m);
    }
    return m;
  }

  request(dep: string, latencyMs: number): void {
    const m = this.of(dep);
    m.requests += 1;
    m.latencies.push(latencyMs);
    if (m.latencies.length > SAMPLE_WINDOW) m.latencies.shift();
  }

  failure(dep: string, error: string): void {
    const m = this.of(dep);
    m.failures += 1;
    m.lastError = error.slice(0, 200);
  }

  retry(dep: string): void { this.of(dep).retries += 1; }
  staleServed(dep: string): void { this.of(dep).staleServed += 1; }
  cacheHit(dep: string): void { this.of(dep).cacheHits += 1; }

  snapshot(): DependencyStats[] {
    return [...this.deps.entries()].map(([dependency, m]) => {
      const sorted = [...m.latencies].sort((a, b) => a - b);
      const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null : null);
      return {
        dependency,
        requests: m.requests,
        failures: m.failures,
        retries: m.retries,
        staleServed: m.staleServed,
        cacheHits: m.cacheHits,
        p50Ms: pct(0.5),
        p95Ms: pct(0.95),
        lastError: m.lastError,
      };
    });
  }
}
