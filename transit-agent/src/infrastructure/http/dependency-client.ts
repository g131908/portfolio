// One resilient client per remote dependency. Callers ask for "validated JSON at this URL"
// and get back data plus its freshness; timeouts, retries, the circuit breaker, caching and
// metrics stay hidden in here (one deep module instead of five shallow wrappers).

import type { ZodType } from 'zod';
import type { Observed } from '../../core/index.js';
import { CircuitBreaker } from './circuit-breaker.js';
import type { Metrics } from './metrics.js';
import { ResponseCache, type CacheEntry } from './response-cache.js';

export type UpstreamFailureKind = 'timeout' | 'network' | 'http' | 'invalid-data' | 'circuit-open' | 'budget-exhausted';

export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';
  constructor(
    readonly dependency: string,
    readonly kind: UpstreamFailureKind,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }

  /** Transient problems that another attempt may fix. */
  get retryable(): boolean {
    if (this.kind === 'timeout' || this.kind === 'network') return true;
    if (this.kind === 'http') return this.status === 429 || (this.status !== null && this.status >= 500);
    return false;
  }

  /** Client errors (4xx except 429) describe the request, not the dependency's health. */
  get isClientError(): boolean {
    return this.kind === 'http' && this.status !== null && this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export interface DependencyPolicy {
  readonly name: string;
  /** Hard limit per attempt. Public transit APIs can hang; we never wait forever. */
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  /** Upper bound for all attempts + backoff together, so callers get a timely answer. */
  readonly totalBudgetMs: number;
  readonly breakerFailureThreshold: number;
  readonly breakerCooldownMs: number;
  readonly cacheMaxEntries: number;
}

export interface Runtime {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly metrics: Metrics;
}

export interface CachePolicy {
  /** Serve from cache without calling upstream for this long. */
  readonly freshMs: number;
  /** If upstream fails, an older copy may be served (marked stale) for this long. */
  readonly staleMs: number;
}

export class DependencyClient {
  readonly breaker: CircuitBreaker;
  private readonly cache: ResponseCache<unknown>;

  constructor(private readonly policy: DependencyPolicy, private readonly rt: Runtime) {
    this.breaker = new CircuitBreaker(policy.name, {
      failureThreshold: policy.breakerFailureThreshold,
      cooldownMs: policy.breakerCooldownMs,
      now: rt.now,
    });
    this.cache = new ResponseCache(policy.cacheMaxEntries, rt.now);
  }

  async getJson<T>(url: string, schema: ZodType<T>, cache: CachePolicy): Promise<Observed<T>> {
    const fresh = this.cache.getFresh(url, cache.freshMs) as CacheEntry<T> | null;
    if (fresh) {
      this.rt.metrics.cacheHit(this.policy.name);
      return { value: fresh.value, asOf: new Date(fresh.storedAt), stale: false };
    }
    try {
      const entry = (await this.cache.singleFlight(url, async () => {
        const value = await this.fetchWithRetry(url, schema);
        this.cache.set(url, value);
        return value;
      })) as T;
      return { value: entry, asOf: new Date(this.rt.now()), stale: false };
    } catch (err) {
      const upstream = err instanceof UpstreamError ? err : null;
      const stale = upstream && !upstream.isClientError ? (this.cache.getStale(url, cache.staleMs) as CacheEntry<T> | null) : null;
      if (stale) {
        this.rt.metrics.staleServed(this.policy.name);
        return { value: stale.value, asOf: new Date(stale.storedAt), stale: true };
      }
      throw err;
    }
  }

  private async fetchWithRetry<T>(url: string, schema: ZodType<T>): Promise<T> {
    const deadline = this.rt.now() + this.policy.totalBudgetMs;
    for (let attempt = 1; ; attempt++) {
      if (!this.breaker.tryAcquire()) {
        throw new UpstreamError(this.policy.name, 'circuit-open', `${this.policy.name} is failing, circuit open`);
      }
      try {
        const value = await this.attempt(url, schema, Math.min(this.policy.timeoutMs, deadline - this.rt.now()));
        this.breaker.onSuccess();
        return value;
      } catch (err) {
        const e = err instanceof UpstreamError ? err : new UpstreamError(this.policy.name, 'network', String(err));
        if (e.isClientError) this.breaker.onNeutral();
        else this.breaker.onFailure();
        this.rt.metrics.failure(this.policy.name, `${e.kind}${e.status ? ` ${e.status}` : ''}: ${e.message}`);

        if (!e.retryable || attempt >= this.policy.maxAttempts) throw e;
        const backoff = this.backoffMs(attempt, e.retryAfterMs);
        if (this.rt.now() + backoff >= deadline) {
          throw new UpstreamError(this.policy.name, 'budget-exhausted', `${this.policy.name}: time budget exhausted after ${attempt} attempts (${e.message})`);
        }
        this.rt.metrics.retry(this.policy.name);
        await this.rt.sleep(backoff);
      }
    }
  }

  /** Exponential backoff with full jitter, so many clients do not retry in lockstep. */
  private backoffMs(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) return Math.min(retryAfterMs, this.policy.maxBackoffMs);
    const ceiling = Math.min(this.policy.maxBackoffMs, this.policy.baseBackoffMs * 2 ** (attempt - 1));
    return Math.round(ceiling * this.rt.random());
  }

  private async attempt<T>(url: string, schema: ZodType<T>, timeoutMs: number): Promise<T> {
    const name = this.policy.name;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    const started = this.rt.now();
    let res: Response;
    try {
      res = await this.rt.fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    } catch (err) {
      if (controller.signal.aborted) throw new UpstreamError(name, 'timeout', `${name} did not answer within ${timeoutMs} ms`);
      throw new UpstreamError(name, 'network', `${name} unreachable: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    this.rt.metrics.request(name, this.rt.now() - started);

    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new UpstreamError(name, 'http', `${name} answered HTTP ${res.status}`, res.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new UpstreamError(name, 'invalid-data', `${name} returned a body that is not JSON`);
    }
    // Never trust external data: a malformed response must not reach the cache or the domain.
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new UpstreamError(name, 'invalid-data', `${name} returned unexpected data at ${issue?.path.join('.') || '(root)'}: ${issue?.message}`);
    }
    return parsed.data;
  }
}
