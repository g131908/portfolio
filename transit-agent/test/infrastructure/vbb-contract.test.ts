import { describe, expect, it } from 'vitest';
import { NotFoundError, DependencyUnavailableError } from '../../src/core/index.js';
import { FIXTURE_NOW, ManualClock, json, recordedUpstream, servicesWith } from '../helpers.js';

// Contract tests: recorded responses from the real VBB and Open-Meteo APIs must map to the domain.
describe('VBB + Open-Meteo adapters against recorded responses', () => {
  it('maps stop search, ignoring addresses', async () => {
    const s = servicesWith(recordedUpstream());
    const { value } = await s.findStops.execute({ query: 'Alexanderplatz' });
    expect(value.map((x) => x.id)).toEqual(['900100003', '900100026']);
    expect(value[0]?.products).toEqual(['suburban', 'subway', 'tram', 'bus', 'regional']);
  });

  it('builds a departure board from live data', async () => {
    const s = servicesWith(recordedUpstream());
    const board = await s.departureBoard.execute({ stop: 'Alexanderplatz' });
    expect(board.stop.name).toBe('S+U Alexanderplatz Bhf (Berlin)');
    expect(board.rows.map((r) => [r.line, r.time, r.status, r.delayMinutes])).toEqual([
      ['U5', '18:00', 'slightly-late', 2],
      ['S7', '18:01', 'on-time', 0],
      ['M5', '18:04', 'cancelled', null],
      ['248', '18:07', 'no-live-data', null],
      ['RE1', '18:15', 'late', 7],
    ]);
    expect(board.rows[0]).toMatchObject({ occupancy: 'medium', color: '#805233', platform: '1 (U5)' });
    expect(board.rows[1]?.occupancy).toBe('high');
    expect(board.disruptions).toEqual(['Construction work: trams replaced by buses']);
  });

  it('plans a trip with bike advice from live weather', async () => {
    const s = servicesWith(recordedUpstream());
    const plan = await s.planTrip.execute({ from: 'Alexanderplatz', to: '900003201' });
    expect(plan.options).toHaveLength(2); // the cancelled tram option is dropped
    expect(plan.options[1]?.legs.map((l) => l.mode)).toEqual(['walk', 'subway']);
    expect(plan.options[1]?.warnings).toEqual(['Lift out of service at Hauptbahnhof']);
    expect(plan.advice).toMatchObject({ mode: 'transit' });
    expect(plan.weatherAvailable).toBe(true);
    // S7 takes 6 min; ~3 km by bike takes ~14 min
    expect(plan.advice?.reasons).toEqual(['public transport is 8 min faster']);
  });

  it('turns an unknown stop id into NotFoundError', async () => {
    const s = servicesWith(recordedUpstream());
    await expect(s.departureBoard.execute({ stop: '900999999' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reports the outage when VBB is down and nothing is cached', async () => {
    const up = recordedUpstream().on(/departures/, () => json({}, 503));
    const s = servicesWith(up);
    await expect(s.departureBoard.execute({ stop: 'Alexanderplatz' })).rejects.toBeInstanceOf(DependencyUnavailableError);
    const health = s.health();
    expect(health.dependencies.find((d) => d.dependency === 'vbb')?.retries).toBe(2);
  });

  it('keeps answering from cache (marked stale) during an outage', async () => {
    const clock = new ManualClock(FIXTURE_NOW.getTime());
    const up = recordedUpstream();
    const s = servicesWith(up, clock);
    await s.departureBoard.execute({ stop: 'Alexanderplatz' });
    clock.advance(60_000);
    up.on(/departures/, () => json({}, 503));
    const board = await s.departureBoard.execute({ stop: 'Alexanderplatz' });
    expect(board.stale).toBe(true);
    expect(board.rows.length).toBeGreaterThan(0);
  });

  it('rejects responses that break the contract instead of caching garbage', async () => {
    const up = recordedUpstream().on(/departures/, () => json({ departures: [{ tripId: 1 }] }));
    const s = servicesWith(up);
    await expect(s.departureBoard.execute({ stop: 'Alexanderplatz' })).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(s.health().dependencies.find((d) => d.dependency === 'vbb')?.lastError).toMatch(/invalid-data/);
  });
});
