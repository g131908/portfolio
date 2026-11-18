import {
  bestKnownTime, delaySeconds, minutesUntil, punctuality,
  type Departure, type Punctuality, type Stop,
} from '../domain/transit.js';
import { InvalidRequestError, type Clock, type TransitGateway } from '../ports.js';
import type { FindStops } from './find-stops.js';

export interface DepartureBoardRequest {
  readonly stop: string;
  readonly windowMinutes?: number;
  readonly limit?: number;
  /** Optional filter, e.g. "U8" or "M10". Case-insensitive. */
  readonly line?: string;
}

export interface BoardRow {
  readonly line: string;
  readonly product: string;
  readonly color: string | null;
  readonly direction: string;
  readonly platform: string | null;
  readonly inMinutes: number;
  readonly time: string;
  readonly delayMinutes: number | null;
  readonly status: Punctuality;
  readonly occupancy: Departure['occupancy'];
}

export interface DepartureBoard {
  readonly stop: Pick<Stop, 'id' | 'name'>;
  readonly rows: readonly BoardRow[];
  readonly summary: {
    readonly total: number;
    readonly delayed: number;
    readonly cancelled: number;
    readonly averageDelayMinutes: number;
  };
  /** Distinct operator warnings affecting this stop right now. */
  readonly disruptions: readonly string[];
  readonly asOf: Date;
  readonly stale: boolean;
}

const BERLIN_TIME = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });

export class GetDepartureBoard {
  constructor(
    private readonly transit: TransitGateway,
    private readonly stops: FindStops,
    private readonly clock: Clock,
  ) {}

  async execute(req: DepartureBoardRequest): Promise<DepartureBoard> {
    const windowMinutes = req.windowMinutes ?? 30;
    if (windowMinutes < 1 || windowMinutes > 120) throw new InvalidRequestError('windowMinutes must be 1..120');
    const limit = Math.min(Math.max(req.limit ?? 12, 1), 40);

    const stop = await this.stops.resolve(req.stop);
    const observed = await this.transit.departures(stop.id, { durationMinutes: windowMinutes, limit: limit * 2 });
    const now = this.clock.now();
    const lineFilter = req.line?.trim().toLowerCase();

    const departures = observed.value
      .filter((d) => !lineFilter || d.line.name.toLowerCase() === lineFilter)
      // a stale copy can contain trains that already left
      .filter((d) => d.cancelled || bestKnownTime(d).getTime() >= now.getTime() - 60_000)
      .sort((a, b) => bestKnownTime(a).getTime() - bestKnownTime(b).getTime())
      .slice(0, limit);

    const delays = departures.map(delaySeconds).filter((d): d is number => d !== null && d > 0);
    const rows = departures.map((d): BoardRow => {
      const delay = delaySeconds(d);
      return {
        line: d.line.name,
        product: d.line.product,
        color: d.line.color,
        direction: d.direction,
        platform: d.platform,
        inMinutes: minutesUntil(d, now),
        time: BERLIN_TIME.format(bestKnownTime(d)),
        delayMinutes: delay === null ? null : Math.round(delay / 60),
        status: punctuality(d),
        occupancy: d.occupancy,
      };
    });

    return {
      stop: { id: stop.id, name: stop.name },
      rows,
      summary: {
        total: rows.length,
        delayed: rows.filter((r) => r.status === 'late' || r.status === 'slightly-late').length,
        cancelled: rows.filter((r) => r.status === 'cancelled').length,
        averageDelayMinutes: delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length / 6) / 10 : 0,
      },
      disruptions: [...new Set(departures.flatMap((d) => d.warnings))].slice(0, 5),
      asOf: observed.asOf,
      stale: observed.stale,
    };
  }
}
