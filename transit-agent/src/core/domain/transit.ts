// Domain model for public transport. Pure data + rules, no I/O, no framework types.

export type Product = 'suburban' | 'subway' | 'tram' | 'bus' | 'ferry' | 'regional' | 'express';

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

export interface Stop {
  readonly id: string;
  readonly name: string;
  readonly location: GeoPoint | null;
  readonly products: readonly Product[];
}

export interface Line {
  readonly name: string;
  readonly product: Product | 'other';
  readonly color: string | null;
}

export type Occupancy = 'low' | 'medium' | 'high' | 'unknown';

export interface Departure {
  readonly tripId: string;
  readonly line: Line;
  readonly direction: string;
  readonly plannedAt: Date;
  /** Real-time prognosis; null when the operator has no live data for this trip. */
  readonly expectedAt: Date | null;
  readonly platform: string | null;
  readonly cancelled: boolean;
  readonly occupancy: Occupancy;
  /** Operator warnings (disruptions, construction work). Hints like "bicycles allowed" are not warnings. */
  readonly warnings: readonly string[];
}

export type Punctuality = 'on-time' | 'slightly-late' | 'late' | 'cancelled' | 'no-live-data';

const SLIGHT_DELAY_S = 60;
const LATE_DELAY_S = 5 * 60;

/** The time a rider should plan with: live prognosis if available, otherwise the timetable. */
export function bestKnownTime(dep: Departure): Date {
  return dep.expectedAt ?? dep.plannedAt;
}

export function delaySeconds(dep: Departure): number | null {
  if (dep.expectedAt === null) return null;
  return Math.round((dep.expectedAt.getTime() - dep.plannedAt.getTime()) / 1000);
}

export function punctuality(dep: Departure): Punctuality {
  if (dep.cancelled) return 'cancelled';
  const delay = delaySeconds(dep);
  if (delay === null) return 'no-live-data';
  if (delay >= LATE_DELAY_S) return 'late';
  if (delay >= SLIGHT_DELAY_S) return 'slightly-late';
  return 'on-time';
}

/** Whole minutes until departure, never negative ("now" = 0). */
export function minutesUntil(dep: Departure, now: Date): number {
  return Math.max(0, Math.floor((bestKnownTime(dep).getTime() - now.getTime()) / 60_000));
}

// --- journeys -----------------------------------------------------------------

export interface TransitLeg {
  readonly kind: 'transit';
  readonly line: Line;
  readonly direction: string;
  readonly from: Stop;
  readonly to: Stop;
  readonly departure: Date;
  readonly arrival: Date;
  readonly departureDelaySeconds: number | null;
  readonly cancelled: boolean;
  readonly warnings: readonly string[];
}

export interface WalkLeg {
  readonly kind: 'walk';
  readonly from: Stop;
  readonly to: Stop;
  readonly departure: Date;
  readonly arrival: Date;
  readonly distanceMeters: number | null;
}

export type Leg = TransitLeg | WalkLeg;

export interface Journey {
  readonly legs: readonly Leg[];
}

export function journeyStart(j: Journey): Date {
  const first = j.legs[0];
  if (!first) throw new Error('Journey without legs');
  return first.departure;
}

export function journeyEnd(j: Journey): Date {
  const last = j.legs[j.legs.length - 1];
  if (!last) throw new Error('Journey without legs');
  return last.arrival;
}

export function durationMinutes(j: Journey): number {
  return Math.round((journeyEnd(j).getTime() - journeyStart(j).getTime()) / 60_000);
}

export function transfers(j: Journey): number {
  return Math.max(0, j.legs.filter((l) => l.kind === 'transit').length - 1);
}

export function isFeasible(j: Journey): boolean {
  return j.legs.length > 0 && !j.legs.some((l) => l.kind === 'transit' && l.cancelled);
}

export function journeyWarnings(j: Journey): string[] {
  return [...new Set(j.legs.flatMap((l) => (l.kind === 'transit' ? l.warnings : [])))];
}

/** Straight-line distance in metres (haversine). */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
