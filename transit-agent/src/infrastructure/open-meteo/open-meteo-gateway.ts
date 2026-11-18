import { z } from 'zod';
import {
  DependencyUnavailableError, describeWeatherCode,
  type GeoPoint, type Observed, type WeatherGateway, type WeatherNow,
} from '../../core/index.js';
import { UpstreamError, type DependencyClient } from '../http/dependency-client.js';

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

const responseSchema = z.object({
  current: z.object({
    temperature_2m: z.number(),
    precipitation: z.number(),
    wind_speed_10m: z.number(),
    weather_code: z.number(),
  }),
  hourly: z.object({ precipitation_probability: z.array(z.number().nullable()) }).nullish(),
});

export class OpenMeteoWeatherGateway implements WeatherGateway {
  constructor(private readonly http: DependencyClient, private readonly baseUrl = OPEN_METEO_URL) {}

  async current(at: GeoPoint): Promise<Observed<WeatherNow>> {
    // Rounding to ~1 km makes nearby stops share one cache entry.
    const lat = at.latitude.toFixed(2);
    const lon = at.longitude.toFixed(2);
    const url = `${this.baseUrl}?latitude=${lat}&longitude=${lon}`
      + '&current=temperature_2m,precipitation,wind_speed_10m,weather_code'
      + '&hourly=precipitation_probability&forecast_hours=2&timezone=Europe%2FBerlin';
    try {
      const res = await this.http.getJson(url, responseSchema, { freshMs: 10 * 60_000, staleMs: 2 * 3_600_000 });
      const c = res.value.current;
      const probs = (res.value.hourly?.precipitation_probability ?? []).filter((p): p is number => p !== null);
      return {
        ...res,
        value: {
          temperatureC: Math.round(c.temperature_2m * 10) / 10,
          precipitationMm: c.precipitation,
          precipitationProbability: probs.length ? Math.max(...probs) : 0,
          windKmh: c.wind_speed_10m,
          weatherCode: c.weather_code,
          description: describeWeatherCode(c.weather_code),
        },
      };
    } catch (err) {
      if (err instanceof UpstreamError) {
        throw new DependencyUnavailableError('open-meteo', `Weather data is unavailable right now (${err.kind})`, { cause: err });
      }
      throw err;
    }
  }
}
