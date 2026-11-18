import type { WeatherNow } from '../domain/mobility-advice.js';
import type { Stop } from '../domain/transit.js';
import { NotFoundError, type Observed, type WeatherGateway } from '../ports.js';
import type { FindStops } from './find-stops.js';

export interface StopWeather {
  readonly stop: Pick<Stop, 'id' | 'name'>;
  readonly weather: Observed<WeatherNow>;
}

export class GetWeatherAtStop {
  constructor(private readonly weather: WeatherGateway, private readonly stops: FindStops) {}

  async execute(req: { stop: string }): Promise<StopWeather> {
    const stop = await this.stops.resolve(req.stop);
    if (!stop.location) throw new NotFoundError(`No coordinates known for ${stop.name}`);
    return { stop: { id: stop.id, name: stop.name }, weather: await this.weather.current(stop.location) };
  }
}
