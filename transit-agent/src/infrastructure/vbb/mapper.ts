// Translates VBB wire format into domain objects. No business decisions here.

import type { Departure, Journey, Leg, Line, Occupancy, Product, Stop } from '../../core/index.js';
import type { VbbDeparture, VbbLeg, VbbStop } from './schemas.js';

const PRODUCTS: readonly Product[] = ['suburban', 'subway', 'tram', 'bus', 'ferry', 'regional', 'express'];

function toProduct(p: string | null | undefined): Product | 'other' {
  return (PRODUCTS as readonly string[]).includes(p ?? '') ? (p as Product) : 'other';
}

export function toStop(s: Pick<VbbStop, 'id' | 'name'> & Partial<Pick<VbbStop, 'location' | 'products'>>): Stop {
  return {
    id: s.id,
    name: s.name,
    location: s.location ? { latitude: s.location.latitude, longitude: s.location.longitude } : null,
    products: PRODUCTS.filter((p) => s.products?.[p] === true),
  };
}

function toLine(l: { name: string; product?: string | null | undefined; color?: { bg: string } | null | undefined }): Line {
  return { name: l.name, product: toProduct(l.product), color: l.color?.bg ?? null };
}

type Remark = { type: string; code?: string | null | undefined; summary?: string | null | undefined; text?: string | null | undefined };

/** Only real warnings (disruptions, construction work); hints like "bicycles allowed" are dropped. */
function warnings(remarks: readonly Remark[] | null | undefined): string[] {
  return (remarks ?? [])
    .filter((r) => r.type === 'warning' || r.type === 'status')
    .map((r) => (r.summary || r.text || '').trim())
    .filter((t) => t.length > 0);
}

// VBB encodes the expected load as e.g. "text.occup.loc.max.12"; 11 = low, 12 = medium, 13 = high.
function occupancy(remarks: readonly Remark[] | null | undefined): Occupancy {
  const code = (remarks ?? []).map((r) => r.code ?? '').find((c) => c.startsWith('text.occup'));
  if (!code) return 'unknown';
  if (code.endsWith('.11')) return 'low';
  if (code.endsWith('.12')) return 'medium';
  if (code.endsWith('.13')) return 'high';
  return 'unknown';
}

function date(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Returns null for records too broken to show (no planned time). */
export function toDeparture(d: VbbDeparture): Departure | null {
  const plannedAt = date(d.plannedWhen) ?? date(d.when);
  if (!plannedAt) return null;
  const cancelled = d.cancelled === true;
  return {
    tripId: d.tripId,
    line: toLine(d.line),
    direction: d.direction ?? '',
    plannedAt,
    // "when" without a "delay" is just the timetable time repeated: no live data
    expectedAt: cancelled || d.delay === null || d.delay === undefined ? null : date(d.when),
    platform: d.platform ?? null,
    cancelled,
    occupancy: occupancy(d.remarks),
    warnings: warnings(d.remarks),
  };
}

function toLeg(l: VbbLeg): Leg | null {
  const departure = date(l.departure) ?? date(l.plannedDeparture);
  const arrival = date(l.arrival) ?? date(l.plannedArrival);
  if (!departure || !arrival) return null;
  const from = toStop(l.origin);
  const to = toStop(l.destination);
  if (l.walking || !l.line) {
    return { kind: 'walk', from, to, departure, arrival, distanceMeters: l.distance ?? null };
  }
  return {
    kind: 'transit',
    line: toLine(l.line),
    direction: l.direction ?? '',
    from, to, departure, arrival,
    departureDelaySeconds: l.departureDelay ?? null,
    cancelled: l.cancelled === true,
    warnings: warnings(l.remarks),
  };
}

export function toJourney(j: { legs: VbbLeg[] }): Journey | null {
  const legs = j.legs.map(toLeg);
  if (legs.some((l) => l === null)) return null;
  return { legs: legs as Leg[] };
}
