import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DependencyClient, UpstreamError, type DependencyPolicy } from '../../src/infrastructure/http/dependency-client.js';
import { Metrics } from '../../src/infrastructure/http/metrics.js';
import { FakeUpstream, ManualClock, json } from '../helpers.js';

const policy: DependencyPolicy = {
  name: 'test-api', timeoutMs: 1_000, maxAttempts: 3, baseBackoffMs: 100, maxBackoffMs: 1_000,
  totalBudgetMs: 5_000, breakerFailureThreshold: 3, breakerCooldownMs: 30_000, cacheMaxEntries: 2,
};
const schema = z.object({ n: z.number() });
const cache = { freshMs: 10_000, staleMs: 60_000 };
const URL_A = 'https://api.test/a';

function setup(over: Partial<DependencyPolicy> = {}) {
  const clock = new ManualClock();
  const upstream = new FakeUpstream();
  const metrics = new Metrics();
  const sleeps: number[] = [];
  const client = new DependencyClient({ ...policy, ...over }, {
    fetch: upstream.fetch, now: () => clock.now().getTime(), random: () => 1, metrics,
    sleep: async (ms) => { sleeps.push(ms); clock.advance(ms); },
  });
  return { clock, upstream, metrics, client, sleeps };
}

afterEach(() => vi.useRealTimers());

describe('DependencyClient', () => {
  it('serves repeated reads from cache inside the fresh window', async () => {
    const { client, upstream, clock } = setup();
    upstream.on(/\/a/, () => json({ n: 1 }));
    await client.getJson(URL_A, schema, cache);
    clock.advance(5_000);
    const second = await client.getJson(URL_A, schema, cache);
    expect(second).toMatchObject({ value: { n: 1 }, stale: false });
    expect(upstream.count(/\/a/)).toBe(1);
  });

  it('collapses concurrent misses into one upstream call (no cache stampede)', async () => {
    const { client, upstream } = setup();
    upstream.on(/\/a/, async () => { await new Promise((r) => setTimeout(r, 5)); return json({ n: 1 }); });
    await Promise.all(Array.from({ length: 10 }, () => client.getJson(URL_A, schema, cache)));
    expect(upstream.count(/\/a/)).toBe(1);
  });

  it('retries transient 5xx with exponential backoff, then succeeds', async () => {
    const { client, upstream, sleeps, metrics } = setup();
    let n = 0;
    upstream.on(/\/a/, () => (++n < 3 ? json({}, 503) : json({ n: 3 })));
    const res = await client.getJson(URL_A, schema, cache);
    expect(res.value.n).toBe(3);
    expect(sleeps).toEqual([100, 200]);
    expect(metrics.snapshot()[0]).toMatchObject({ retries: 2, failures: 2 });
  });

  it('honours Retry-After on 429', async () => {
    const { client, upstream, sleeps } = setup();
    let n = 0;
    upstream.on(/\/a/, () => (++n === 1 ? json({}, 429, { 'retry-after': '1' }) : json({ n: 1 })));
    await client.getJson(URL_A, schema, cache);
    expect(sleeps).toEqual([1_000]);
  });

  it('does not retry client errors or invalid data', async () => {
    const { client, upstream } = setup();
    upstream.on(/\/a/, () => json({}, 404));
    await expect(client.getJson(URL_A, schema, cache)).rejects.toMatchObject({ kind: 'http', status: 404 });
    upstream.on(/\/a/, () => json({ n: 'not a number' }));
    await expect(client.getJson(URL_A, schema, cache)).rejects.toMatchObject({ kind: 'invalid-data' });
    expect(upstream.count(/\/a/)).toBe(2);
  });

  it('times out hanging requests instead of waiting forever', async () => {
    vi.useFakeTimers();
    const { client, upstream } = setup({ maxAttempts: 1 });
    upstream.on(/\/a/, (_u, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const p = client.getJson(URL_A, schema, cache);
    const assertion = expect(p).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
  });

  it('serves a stale copy marked as stale when upstream fails', async () => {
    const { client, upstream, clock } = setup({ maxAttempts: 1 });
    upstream.on(/\/a/, () => json({ n: 7 }));
    await client.getJson(URL_A, schema, cache);
    clock.advance(30_000);
    upstream.on(/\/a/, () => json({}, 502));
    const res = await client.getJson(URL_A, schema, cache);
    expect(res).toMatchObject({ value: { n: 7 }, stale: true });
    expect(res.asOf.getTime()).toBe(clock.now().getTime() - 30_000);
  });

  it('opens the circuit after repeated failures and probes again after the cool-down', async () => {
    const { client, upstream, clock } = setup({ maxAttempts: 1 });
    upstream.on(/\/a/, () => json({}, 500));
    for (let i = 0; i < 3; i++) await expect(client.getJson(URL_A, schema, cache)).rejects.toBeInstanceOf(UpstreamError);
    expect(client.breaker.snapshot().state).toBe('open');

    await expect(client.getJson(URL_A, schema, cache)).rejects.toMatchObject({ kind: 'circuit-open' });
    expect(upstream.count(/\/a/)).toBe(3); // fail fast: no 4th request

    clock.advance(30_000);
    upstream.on(/\/a/, () => json({ n: 1 }));
    await client.getJson(URL_A, schema, cache);
    expect(client.breaker.snapshot().state).toBe('closed');
  });

  it('a 404 does not count against the dependency health', async () => {
    const { client, upstream } = setup({ maxAttempts: 1 });
    upstream.on(/\/a/, () => json({}, 404));
    for (let i = 0; i < 5; i++) await expect(client.getJson(URL_A, schema, cache)).rejects.toBeTruthy();
    expect(client.breaker.snapshot().state).toBe('closed');
  });

  it('respects the total time budget', async () => {
    const { client, upstream } = setup({ maxAttempts: 10, baseBackoffMs: 2_000, maxBackoffMs: 4_000, totalBudgetMs: 5_000 });
    upstream.on(/\/a/, () => json({}, 503));
    await expect(client.getJson(URL_A, schema, cache)).rejects.toMatchObject({ kind: 'budget-exhausted' });
    expect(upstream.count(/\/a/)).toBeLessThanOrEqual(3);
  });

  it('keeps the cache bounded (LRU)', async () => {
    const { client, upstream } = setup();
    upstream.on(/./, () => json({ n: 1 }));
    for (const p of ['a', 'b', 'c']) await client.getJson(`https://api.test/${p}`, schema, cache);
    await client.getJson('https://api.test/a', schema, cache); // evicted -> refetched
    expect(upstream.count(/\/a/)).toBe(2);
  });
});
