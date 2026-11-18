import { describe, expect, it } from 'vitest';
import {
  FindStops, GetDepartureBoard, InvalidRequestError, NotFoundError, PlanTrip,
  type Departure, type Journey, type Observed, type Stop, type TransitGateway, type WeatherGateway, type WeatherNow,
} from '../../src/core/index.js';

// In-memory fakes: use cases are tested without network, HTTP or JSON.
const NOW = new Date('2026-11-18T17:58:00+01:00');
const clock = { now: () => NOW };
const obs = <T>(value: T, stale = false): Observed<T> => ({ value, asOf: NOW, stale });
const alex: Stop = { id: '900100003', name: 'S+U Alexanderplatz', location: { latitude: 52.5215, longitude: 13.4113 }, products: ['subway'] };
const hbf: Stop = { id: '900003201', name: 'S+U Hauptbahnhof', location: { latitude: 52.5256, longitude: 13.3691 }, products: ['suburban'] };

const at = (hhmm: string) => new Date(`2026-11-18T${hhmm}:00+01:00`);
const dep = (line: string, planned: string, expected: string | null, extra: Partial<Departure> = {}): Departure => ({
  tripId: `${line}-${planned}`, line: { name: line, product: 'subway', color: null }, direction: 'X',
  plannedAt: at(planned), expectedAt: expected ? at(expected) : null, platform: null, cancelled: false,
  occupancy: 'unknown', warnings: [], ...extra,
});

class FakeTransit implements TransitGateway {
  departuresList: Departure[] = [];
  journeyList: Journey[] = [];
  stale = false;
  async searchStops(q: string) { return obs([alex, hbf].filter((s) => s.name.toLowerCase().includes(q.toLowerCase()))); }
  async stopById(id: string) {
    const s = [alex, hbf].find((x) => x.id === id);
    if (!s) throw new NotFoundError('unknown');
    return obs(s);
  }
  async departures() { return obs(this.departuresList, this.stale); }
  async journeys() { return obs(this.journeyList, this.stale); }
}

const weatherOk: WeatherGateway = {
  async current() { return obs<WeatherNow>({ temperatureC: 12, precipitationMm: 0, precipitationProbability: 5, windKmh: 8, description: 'clear sky' }); },
};
const weatherDown: WeatherGateway = { async current() { throw new Error('down'); } };

describe('FindStops', () => {
  const find = new FindStops(new FakeTransit());
  it('rejects too short queries', async () => {
    await expect(find.execute({ query: ' a ' })).rejects.toBeInstanceOf(InvalidRequestError);
  });
  it('resolves names and ids to one stop', async () => {
    expect((await find.resolve('hauptbahnhof')).id).toBe('900003201');
    expect((await find.resolve('900100003')).name).toBe('S+U Alexanderplatz');
    await expect(find.resolve('Nowhere')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('GetDepartureBoard', () => {
  const transit = new FakeTransit();
  const board = new GetDepartureBoard(transit, new FindStops(transit), clock);

  it('sorts by live time, summarises delays and filters by line', async () => {
    transit.departuresList = [
      dep('U8', '18:05', '18:05'),
      dep('U5', '18:00', '18:06'),
      dep('M4', '18:02', null, { cancelled: true, warnings: ['Tram replaced by bus', 'Tram replaced by bus'] }),
    ];
    const b = await board.execute({ stop: 'Alexanderplatz' });
    expect(b.rows.map((r) => r.line)).toEqual(['M4', 'U8', 'U5']);
    expect(b.summary).toMatchObject({ total: 3, delayed: 1, cancelled: 1, averageDelayMinutes: 6 });
    expect(b.disruptions).toEqual(['Tram replaced by bus']);

    const u8 = await board.execute({ stop: 'Alexanderplatz', line: 'u8' });
    expect(u8.rows).toHaveLength(1);
  });

  it('hides trains that already left when serving a stale copy', async () => {
    transit.departuresList = [dep('U2', '17:40', '17:41'), dep('U2', '18:10', '18:10')];
    transit.stale = true;
    const b = await board.execute({ stop: '900100003' });
    expect(b.rows).toHaveLength(1);
    expect(b.stale).toBe(true);
    transit.stale = false;
  });

  it('validates the time window', async () => {
    await expect(board.execute({ stop: 'Alex', windowMinutes: 500 })).rejects.toBeInstanceOf(InvalidRequestError);
  });
});

describe('PlanTrip', () => {
  const leg = (dep: string, arr: string, cancelled = false) => ({
    kind: 'transit' as const, line: { name: 'S7', product: 'suburban' as const, color: null }, direction: 'Potsdam',
    from: alex, to: hbf, departure: at(dep), arrival: at(arr), departureDelaySeconds: 0, cancelled, warnings: [],
  });

  it('drops cancelled options and adds bike advice', async () => {
    const transit = new FakeTransit();
    transit.journeyList = [{ legs: [leg('18:01', '18:07')] }, { legs: [leg('18:03', '18:09', true)] }];
    const plan = await new PlanTrip(transit, weatherOk, new FindStops(transit), clock).execute({ from: 'Alexanderplatz', to: 'Hauptbahnhof' });
    expect(plan.options).toHaveLength(1);
    expect(plan.options[0]).toMatchObject({ departure: '18:01', arrival: '18:07', durationMinutes: 6, transfers: 0 });
    expect(plan.advice?.mode).toBe('transit');
  });

  it('still answers when the weather service is down (graceful degradation)', async () => {
    const transit = new FakeTransit();
    transit.journeyList = [{ legs: [leg('18:01', '18:07')] }];
    const plan = await new PlanTrip(transit, weatherDown, new FindStops(transit), clock).execute({ from: 'Alexanderplatz', to: 'Hauptbahnhof' });
    expect(plan.weatherAvailable).toBe(false);
    expect(plan.advice?.reasons).toContain('public transport is ' + (plan.advice!.bikeMinutes - 6) + ' min faster');
  });

  it('rejects identical start and destination and far-future dates', async () => {
    const transit = new FakeTransit();
    const plan = new PlanTrip(transit, weatherOk, new FindStops(transit), clock);
    await expect(plan.execute({ from: 'Alexanderplatz', to: '900100003' })).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(plan.execute({ from: 'Alex', to: 'Haupt', departAt: '2030-01-01T10:00:00Z' })).rejects.toBeInstanceOf(InvalidRequestError);
  });
});
