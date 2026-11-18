import {
  durationMinutes, isFeasible, journeyEnd, journeyStart, journeyWarnings, transfers,
  type Journey, type Stop,
} from '../domain/transit.js';
import { adviseMobility, type MobilityAdvice } from '../domain/mobility-advice.js';
import { InvalidRequestError, type Clock, type TransitGateway, type WeatherGateway } from '../ports.js';
import type { FindStops } from './find-stops.js';

export interface PlanTripRequest {
  readonly from: string;
  readonly to: string;
  /** ISO time; defaults to now. */
  readonly departAt?: string;
  readonly results?: number;
}

export interface TripLeg {
  readonly mode: string;
  readonly line: string | null;
  readonly color: string | null;
  readonly direction: string | null;
  readonly from: string;
  readonly to: string;
  readonly departure: string;
  readonly arrival: string;
  readonly delayMinutes: number | null;
}

export interface TripOption {
  readonly departure: string;
  readonly arrival: string;
  readonly durationMinutes: number;
  readonly transfers: number;
  readonly legs: readonly TripLeg[];
  readonly warnings: readonly string[];
}

export interface TripPlan {
  readonly from: Pick<Stop, 'id' | 'name'>;
  readonly to: Pick<Stop, 'id' | 'name'>;
  readonly options: readonly TripOption[];
  readonly advice: MobilityAdvice | null;
  readonly weatherAvailable: boolean;
  readonly asOf: Date;
  readonly stale: boolean;
}

const HHMM = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });

function toOption(j: Journey): TripOption {
  return {
    departure: HHMM.format(journeyStart(j)),
    arrival: HHMM.format(journeyEnd(j)),
    durationMinutes: durationMinutes(j),
    transfers: transfers(j),
    warnings: journeyWarnings(j).slice(0, 3),
    legs: j.legs.map((l): TripLeg => ({
      mode: l.kind === 'walk' ? 'walk' : l.line.product,
      line: l.kind === 'walk' ? null : l.line.name,
      color: l.kind === 'walk' ? null : l.line.color,
      direction: l.kind === 'walk' ? null : l.direction,
      from: l.from.name,
      to: l.to.name,
      departure: HHMM.format(l.departure),
      arrival: HHMM.format(l.arrival),
      delayMinutes: l.kind === 'walk' || l.departureDelaySeconds === null ? null : Math.round(l.departureDelaySeconds / 60),
    })),
  };
}

export class PlanTrip {
  constructor(
    private readonly transit: TransitGateway,
    private readonly weather: WeatherGateway,
    private readonly stops: FindStops,
    private readonly clock: Clock,
  ) {}

  async execute(req: PlanTripRequest): Promise<TripPlan> {
    const departure = req.departAt ? new Date(req.departAt) : null;
    if (departure && Number.isNaN(departure.getTime())) throw new InvalidRequestError('departAt must be an ISO date-time');
    if (departure && Math.abs(departure.getTime() - this.clock.now().getTime()) > 7 * 86_400_000) {
      throw new InvalidRequestError('departAt must be within 7 days');
    }

    // Independent lookups run in parallel; the trip needs both stops.
    const [from, to] = await Promise.all([this.stops.resolve(req.from), this.stops.resolve(req.to)]);
    if (from.id === to.id) throw new InvalidRequestError('Start and destination are the same stop');

    const journeysP = this.transit.journeys(from.id, to.id, { departure, results: Math.min(req.results ?? 3, 5) });
    // Weather is optional: the plan degrades gracefully without it instead of failing.
    const weatherP = from.location ? this.weather.current(from.location).catch(() => null) : Promise.resolve(null);
    const [journeys, weather] = await Promise.all([journeysP, weatherP]);

    const feasible = journeys.value.filter(isFeasible);
    const options = feasible.map(toOption);
    const fastest = options.length ? Math.min(...options.map((o) => o.durationMinutes)) : null;

    const advice = from.location && to.location && departure === null
      ? adviseMobility({ from: from.location, to: to.location, transitMinutes: fastest, weather: weather?.value ?? null })
      : null;

    return {
      from: { id: from.id, name: from.name },
      to: { id: to.id, name: to.name },
      options,
      advice,
      weatherAvailable: weather !== null,
      asOf: journeys.asOf,
      stale: journeys.stale,
    };
  }
}
