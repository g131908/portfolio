import { describe, expect, it } from 'vitest';
import {
  adviseMobility, delaySeconds, durationMinutes, estimateBikeMinutes, minutesUntil, punctuality, transfers,
  type Departure, type Journey, type WeatherNow,
} from '../../src/core/index.js';

const at = (hhmm: string) => new Date(`2026-11-18T${hhmm}:00+01:00`);
const dep = (over: Partial<Departure> = {}): Departure => ({
  tripId: 't', line: { name: 'U8', product: 'subway', color: null }, direction: 'Wittenau',
  plannedAt: at('18:00'), expectedAt: at('18:00'), platform: '1', cancelled: false, occupancy: 'unknown', warnings: [],
  ...over,
});

describe('departure punctuality', () => {
  it.each([
    [at('18:00'), 'on-time'],
    [at('18:01'), 'slightly-late'],
    [at('18:05'), 'late'],
  ] as const)('expected %s -> %s', (expectedAt, status) => {
    expect(punctuality(dep({ expectedAt }))).toBe(status);
  });

  it('distinguishes "no live data" from "on time"', () => {
    expect(punctuality(dep({ expectedAt: null }))).toBe('no-live-data');
    expect(delaySeconds(dep({ expectedAt: null }))).toBeNull();
  });

  it('cancellation wins over any delay', () => {
    expect(punctuality(dep({ cancelled: true, expectedAt: at('18:10') }))).toBe('cancelled');
  });

  it('counts minutes from the live time and never goes negative', () => {
    expect(minutesUntil(dep({ expectedAt: at('18:03') }), at('17:58'))).toBe(5);
    expect(minutesUntil(dep(), at('18:02'))).toBe(0);
  });
});

describe('journeys', () => {
  const stop = { id: '1', name: 'A', location: null, products: [] };
  const j: Journey = {
    legs: [
      { kind: 'walk', from: stop, to: stop, departure: at('18:00'), arrival: at('18:04'), distanceMeters: 200 },
      { kind: 'transit', line: { name: 'S7', product: 'suburban', color: null }, direction: 'x', from: stop, to: stop,
        departure: at('18:05'), arrival: at('18:15'), departureDelaySeconds: 0, cancelled: false, warnings: [] },
      { kind: 'transit', line: { name: 'U5', product: 'subway', color: null }, direction: 'y', from: stop, to: stop,
        departure: at('18:18'), arrival: at('18:30'), departureDelaySeconds: 0, cancelled: false, warnings: [] },
    ],
  };
  it('measures duration door to door and counts transfers between vehicles only', () => {
    expect(durationMinutes(j)).toBe(30);
    expect(transfers(j)).toBe(1);
  });
});

describe('bike or transit policy', () => {
  // BHT (Wedding) -> Alexanderplatz, ~4.3 km straight line
  const bht = { latitude: 52.5447, longitude: 13.3517 };
  const alex = { latitude: 52.5215, longitude: 13.4113 };
  const fine: WeatherNow = { temperatureC: 14, precipitationMm: 0, precipitationProbability: 10, windKmh: 10, weatherCode: 0, description: 'clear sky' };

  it('estimates city cycling time with a detour factor', () => {
    expect(estimateBikeMinutes(bht, alex)).toBeGreaterThanOrEqual(18);
    expect(estimateBikeMinutes(bht, alex)).toBeLessThanOrEqual(24);
  });

  it('recommends the bike when it is clearly faster and the weather is fine', () => {
    const a = adviseMobility({ from: bht, to: alex, transitMinutes: 35, weather: fine });
    expect(a.mode).toBe('bike');
    expect(a.reasons[0]).toMatch(/faster/);
  });

  it('calls it a draw within 5 minutes', () => {
    const bike = estimateBikeMinutes(bht, alex);
    expect(adviseMobility({ from: bht, to: alex, transitMinutes: bike + 3, weather: fine }).mode).toBe('either');
  });

  it('weather vetoes the bike even if it is faster', () => {
    const rainy = { ...fine, precipitationProbability: 80 };
    const a = adviseMobility({ from: bht, to: alex, transitMinutes: 60, weather: rainy });
    expect(a.mode).toBe('transit');
    expect(a.reasons.join()).toMatch(/80% chance of rain/);
  });

  it('treats a rain weather code as rain even when the gauge shows 0 mm', () => {
    const a = adviseMobility({ from: bht, to: alex, transitMinutes: 60, weather: { ...fine, weatherCode: 61, description: 'rain' } });
    expect(a.mode).toBe('transit');
    expect(a.reasons).toContain('current conditions: rain');
  });

  it.each([
    [{ precipitationMm: 1.2 }, /raining/],
    [{ windKmh: 50 }, /strong wind/],
    [{ temperatureC: -3 }, /below freezing/],
  ])('rejects the bike for %o', (over, reason) => {
    const a = adviseMobility({ from: bht, to: alex, transitMinutes: 60, weather: { ...fine, ...over } });
    expect(a.mode).toBe('transit');
    expect(a.reasons.join()).toMatch(reason);
  });

  it('still suggests the bike when no connection exists, with honest caveats', () => {
    const a = adviseMobility({ from: bht, to: alex, transitMinutes: null, weather: { ...fine, windKmh: 60 } });
    expect(a.mode).toBe('bike');
    expect(a.reasons).toContain('but strong wind (60 km/h)');
  });
});
