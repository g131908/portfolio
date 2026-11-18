// Composition root: the only place that knows concrete classes. Web app, MCP server and
// tests all build their object graph here, with different runtimes plugged in.

import { FindStops, GetDepartureBoard, GetWeatherAtStop, PlanTrip, type Clock } from './core/index.js';
import { DependencyClient, type DependencyPolicy, type Runtime } from './infrastructure/http/dependency-client.js';
import { Metrics } from './infrastructure/http/metrics.js';
import { OpenMeteoWeatherGateway } from './infrastructure/open-meteo/open-meteo-gateway.js';
import { VbbTransitGateway } from './infrastructure/vbb/vbb-gateway.js';

export type { DepartureBoard, TripPlan } from './core/index.js';

const VBB_POLICY: DependencyPolicy = {
  name: 'vbb',
  timeoutMs: 6_000,
  maxAttempts: 3,
  baseBackoffMs: 300,
  maxBackoffMs: 2_000,
  totalBudgetMs: 12_000,
  breakerFailureThreshold: 4,
  breakerCooldownMs: 30_000,
  cacheMaxEntries: 300,
};

const WEATHER_POLICY: DependencyPolicy = {
  name: 'open-meteo',
  timeoutMs: 4_000,
  maxAttempts: 2,
  baseBackoffMs: 300,
  maxBackoffMs: 1_000,
  totalBudgetMs: 6_000,
  breakerFailureThreshold: 3,
  breakerCooldownMs: 60_000,
  cacheMaxEntries: 100,
};

export interface Services {
  readonly findStops: FindStops;
  readonly departureBoard: GetDepartureBoard;
  readonly planTrip: PlanTrip;
  readonly weatherAtStop: GetWeatherAtStop;
  readonly clock: Clock;
  /** Operational view for dashboards and health checks. */
  health(): {
    dependencies: ReturnType<Metrics['snapshot']>;
    breakers: ReturnType<DependencyClient['breaker']['snapshot']>[];
  };
}

export interface ServiceOptions {
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
  readonly vbbBaseUrl?: string;
  readonly weatherBaseUrl?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export function createServices(opts: ServiceOptions = {}): Services {
  const clock: Clock = opts.clock ?? { now: () => new Date() };
  const metrics = new Metrics();
  const runtime: Runtime = {
    fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
    now: () => clock.now().getTime(),
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    random: opts.random ?? Math.random,
    metrics,
  };
  const vbbHttp = new DependencyClient(VBB_POLICY, runtime);
  const weatherHttp = new DependencyClient(WEATHER_POLICY, runtime);

  const transit = new VbbTransitGateway(vbbHttp, opts.vbbBaseUrl);
  const weather = new OpenMeteoWeatherGateway(weatherHttp, opts.weatherBaseUrl);
  const findStops = new FindStops(transit);

  return {
    findStops,
    departureBoard: new GetDepartureBoard(transit, findStops, clock),
    planTrip: new PlanTrip(transit, weather, findStops, clock),
    weatherAtStop: new GetWeatherAtStop(weather, findStops),
    clock,
    health: () => ({
      dependencies: metrics.snapshot(),
      breakers: [vbbHttp.breaker.snapshot(), weatherHttp.breaker.snapshot()],
    }),
  };
}
