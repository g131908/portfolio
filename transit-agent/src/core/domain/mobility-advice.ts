// Business policy: should a rider take the bike or public transport?
// Kept as a pure function so the rule is easy to test, explain and change.

import type { GeoPoint } from './transit.js';
import { distanceMeters } from './transit.js';

export interface WeatherNow {
  readonly temperatureC: number;
  readonly precipitationMm: number;
  /** Highest precipitation probability in the next hour, 0..100. */
  readonly precipitationProbability: number;
  readonly windKmh: number;
  readonly description: string;
}

export interface MobilityInput {
  readonly from: GeoPoint;
  readonly to: GeoPoint;
  /** Fastest feasible public transport option, null if none was found. */
  readonly transitMinutes: number | null;
  readonly weather: WeatherNow | null;
}

export type Mode = 'bike' | 'transit' | 'either';

export interface MobilityAdvice {
  readonly mode: Mode;
  readonly bikeMinutes: number;
  readonly transitMinutes: number | null;
  readonly reasons: readonly string[];
}

/** Berlin streets are not straight lines: real cycling routes are ~30% longer. */
export const DETOUR_FACTOR = 1.3;
export const CITY_BIKE_SPEED_KMH = 16;
const MAX_REASONABLE_BIKE_MIN = 45;
const RAIN_PROBABILITY_LIMIT = 60;
const RAIN_MM_LIMIT = 0.5;
const WIND_LIMIT_KMH = 35;
const COLD_LIMIT_C = 0;
const CLOSE_CALL_MIN = 5;

export function estimateBikeMinutes(from: GeoPoint, to: GeoPoint): number {
  const km = (distanceMeters(from, to) * DETOUR_FACTOR) / 1000;
  return Math.max(1, Math.round((km / CITY_BIKE_SPEED_KMH) * 60));
}

export function adviseMobility(input: MobilityInput): MobilityAdvice {
  const bikeMinutes = estimateBikeMinutes(input.from, input.to);
  const { transitMinutes, weather } = input;
  const against: string[] = [];

  if (bikeMinutes > MAX_REASONABLE_BIKE_MIN) against.push(`${bikeMinutes} min by bike is a long ride`);
  if (weather) {
    if (weather.precipitationMm >= RAIN_MM_LIMIT) against.push(`it is raining (${weather.precipitationMm} mm)`);
    else if (weather.precipitationProbability >= RAIN_PROBABILITY_LIMIT) {
      against.push(`${weather.precipitationProbability}% chance of rain in the next hour`);
    }
    if (weather.windKmh >= WIND_LIMIT_KMH) against.push(`strong wind (${Math.round(weather.windKmh)} km/h)`);
    if (weather.temperatureC < COLD_LIMIT_C) against.push(`below freezing (${weather.temperatureC} °C), roads may be icy`);
  }

  if (transitMinutes === null) {
    return {
      mode: 'bike', bikeMinutes, transitMinutes,
      reasons: ['no public transport connection found', ...against.map((r) => `but ${r}`)],
    };
  }

  if (against.length > 0) {
    return { mode: 'transit', bikeMinutes, transitMinutes, reasons: against };
  }

  const diff = transitMinutes - bikeMinutes;
  const weatherNote = weather ? [`weather is fine (${weather.description}, ${weather.temperatureC} °C)`] : ['no weather data available'];
  if (Math.abs(diff) <= CLOSE_CALL_MIN) {
    return { mode: 'either', bikeMinutes, transitMinutes, reasons: [`both take about the same time (±${Math.abs(diff)} min)`, ...weatherNote] };
  }
  if (diff > 0) {
    return { mode: 'bike', bikeMinutes, transitMinutes, reasons: [`the bike is ${diff} min faster`, ...weatherNote] };
  }
  return { mode: 'transit', bikeMinutes, transitMinutes, reasons: [`public transport is ${-diff} min faster`] };
}

/** WMO weather interpretation codes -> short English text. */
export function describeWeatherCode(code: number): string {
  if (code === 0) return 'clear sky';
  if (code <= 2) return 'partly cloudy';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if (code >= 61 && code <= 67) return 'rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'rain showers';
  if (code === 85 || code === 86) return 'snow showers';
  if (code >= 95) return 'thunderstorm';
  return 'unknown';
}
