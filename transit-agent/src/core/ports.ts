// Ports owned by the core. Infrastructure implements them; the core never imports infrastructure.

import type { Departure, GeoPoint, Journey, Stop } from './domain/transit.js';
import type { WeatherNow } from './domain/mobility-advice.js';

/**
 * Every value read from a remote system says how fresh it is.
 * The source of truth is the transit operator; anything we hold is a derived copy that can lag.
 */
export interface Observed<T> {
  readonly value: T;
  /** When the upstream produced this data. */
  readonly asOf: Date;
  /** True when the live source failed and an older cached copy is served instead. */
  readonly stale: boolean;
}

export interface TransitGateway {
  searchStops(query: string, limit: number): Promise<Observed<Stop[]>>;
  /** Resolves a VBB stop id; rejects with NotFoundError for unknown ids. */
  stopById(id: string): Promise<Observed<Stop>>;
  departures(stopId: string, opts: { durationMinutes: number; limit: number }): Promise<Observed<Departure[]>>;
  journeys(fromStopId: string, toStopId: string, opts: { departure: Date | null; results: number }): Promise<Observed<Journey[]>>;
}

export interface WeatherGateway {
  current(at: GeoPoint): Promise<Observed<WeatherNow>>;
}

export interface Clock {
  now(): Date;
}

// --- failures the core understands -------------------------------------------------

/** Caller-side mistake. Never retried. */
export class InvalidRequestError extends Error {
  override readonly name = 'InvalidRequestError';
}

export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}

/** A dependency is down, slow or returned unusable data, and no cached copy exists. */
export class DependencyUnavailableError extends Error {
  override readonly name = 'DependencyUnavailableError';
  constructor(readonly dependency: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
