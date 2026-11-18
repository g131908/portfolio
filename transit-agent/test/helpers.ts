import { readFileSync } from 'node:fs';
import { createServices, type ServiceOptions } from '../src/composition.js';

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** 17:58 Berlin time on the day the fixtures were recorded. */
export const FIXTURE_NOW = new Date('2026-11-18T17:58:00+01:00');

export class ManualClock {
  constructor(private t: number = FIXTURE_NOW.getTime()) {}
  now = () => new Date(this.t);
  advance(ms: number) { this.t += ms; }
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Fake fetch that routes by path prefix and records every call. */
export class FakeUpstream {
  readonly calls: URL[] = [];
  private routes: Array<[RegExp, Handler]> = [];

  on(path: RegExp, handler: Handler): this {
    this.routes.unshift([path, handler]);
    return this;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    this.calls.push(url);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const route = this.routes.find(([re]) => re.test(url.pathname));
    if (!route) return json({ error: 'no route' }, 404);
    return route[1](url, init);
  };

  count(path: RegExp): number {
    return this.calls.filter((u) => path.test(u.pathname)).length;
  }
}

/** Upstream that serves the recorded fixtures, like the real APIs did. */
export function recordedUpstream(): FakeUpstream {
  return new FakeUpstream()
    .on(/^\/locations$/, () => json(fixture('locations-alexanderplatz.json')))
    // later routes win, so the generic 404 comes first
    .on(/^\/stops\/\d+$/, () => json({ message: 'stop not found' }, 404))
    .on(/^\/stops\/900003201$/, () => json(fixture('stop-hauptbahnhof.json')))
    .on(/^\/stops\/\d+\/departures$/, () => json(fixture('departures-alexanderplatz.json')))
    .on(/^\/journeys$/, () => json(fixture('journeys-alex-hbf.json')))
    .on(/^\/v1\/forecast$/, () => json(fixture('open-meteo-current.json')));
}

export function servicesWith(upstream: FakeUpstream, clock = new ManualClock(), extra: Partial<ServiceOptions> = {}) {
  return createServices({
    fetch: upstream.fetch,
    clock,
    sleep: async (ms) => clock.advance(ms),
    random: () => 0.5,
    ...extra,
  });
}
