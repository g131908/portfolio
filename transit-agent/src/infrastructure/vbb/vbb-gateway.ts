import { z } from 'zod';
import {
  DependencyUnavailableError, InvalidRequestError, NotFoundError,
  type Departure, type Journey, type Observed, type Stop, type TransitGateway,
} from '../../core/index.js';
import { UpstreamError, type DependencyClient } from '../http/dependency-client.js';
import { toDeparture, toJourney, toStop } from './mapper.js';
import { departuresResponseSchema, journeysResponseSchema, locationsSchema, stopSchema } from './schemas.js';

export const VBB_BASE_URL = 'https://v6.vbb.transport.rest';

// Departures change every few seconds upstream; stop names almost never.
const CACHE = {
  stops: { freshMs: 24 * 3_600_000, staleMs: 7 * 24 * 3_600_000 },
  departures: { freshMs: 20_000, staleMs: 10 * 60_000 },
  journeys: { freshMs: 30_000, staleMs: 10 * 60_000 },
} as const;

export class VbbTransitGateway implements TransitGateway {
  constructor(private readonly http: DependencyClient, private readonly baseUrl = VBB_BASE_URL) {}

  async searchStops(query: string, limit: number): Promise<Observed<Stop[]>> {
    const url = this.url('/locations', { query, results: limit, fuzzy: true, stops: true, addresses: false, poi: false });
    const res = await this.call(url, locationsSchema, CACHE.stops);
    const stops = res.value
      .filter((l) => l.type === 'stop' || l.type === 'station')
      .flatMap((l) => {
        const parsed = stopSchema.safeParse(l);
        return parsed.success ? [toStop(parsed.data)] : [];
      });
    return { ...res, value: stops };
  }

  async stopById(id: string): Promise<Observed<Stop>> {
    const res = await this.call(this.url(`/stops/${encodeURIComponent(id)}`, {}), stopSchema, CACHE.stops);
    return { ...res, value: toStop(res.value) };
  }

  async departures(stopId: string, opts: { durationMinutes: number; limit: number }): Promise<Observed<Departure[]>> {
    const url = this.url(`/stops/${encodeURIComponent(stopId)}/departures`, {
      duration: opts.durationMinutes, results: opts.limit, remarks: true, linesOfStops: false,
    });
    const res = await this.call(url, departuresResponseSchema, CACHE.departures);
    return { ...res, value: res.value.departures.map(toDeparture).filter((d): d is Departure => d !== null) };
  }

  async journeys(from: string, to: string, opts: { departure: Date | null; results: number }): Promise<Observed<Journey[]>> {
    const params: Record<string, string | number | boolean> = { from, to, results: opts.results, stopovers: false, remarks: true };
    if (opts.departure) params['departure'] = opts.departure.toISOString();
    const res = await this.call(this.url('/journeys', params), journeysResponseSchema, CACHE.journeys);
    return { ...res, value: res.value.journeys.map(toJourney).filter((j): j is Journey => j !== null) };
  }

  private url(path: string, params: Record<string, string | number | boolean>): string {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const q = qs.toString();
    return `${this.baseUrl}${path}${q ? `?${q}` : ''}`;
  }

  /** Translates transport failures into errors the core understands. */
  private async call<T>(url: string, schema: z.ZodType<T>, cache: { freshMs: number; staleMs: number }): Promise<Observed<T>> {
    try {
      return await this.http.getJson(url, schema, cache);
    } catch (err) {
      if (err instanceof UpstreamError) {
        if (err.status === 404) throw new NotFoundError('Stop or connection not found');
        if (err.status === 400) throw new InvalidRequestError('The transit API rejected the request');
        throw new DependencyUnavailableError('vbb', `Berlin transit data is unavailable right now (${err.kind})`, { cause: err });
      }
      throw err;
    }
  }
}
