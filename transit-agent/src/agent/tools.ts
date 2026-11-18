// Tool catalogue shared by the in-app agent and the MCP server.
// Each tool is a thin translation from model-friendly input to one use case.

import { z } from 'zod';
import {
  DependencyUnavailableError, InvalidRequestError, NotFoundError,
  type FindStops, type GetDepartureBoard, type GetWeatherAtStop, type PlanTrip,
} from '../core/index.js';

export interface ToolDeps {
  readonly findStops: FindStops;
  readonly departureBoard: GetDepartureBoard;
  readonly planTrip: PlanTrip;
  readonly weatherAtStop: GetWeatherAtStop;
}

export interface Tool<S extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: S;
  run(input: z.infer<S>): Promise<unknown>;
}

/** Tool output the model can act on, including expected failures. */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; retryable: boolean };

const stopParam = z.string().min(2).max(100)
  .describe('Stop name like "Alexanderplatz" or "Hermannplatz", or a 9-digit VBB stop id');

const freshness = (asOf: Date, stale: boolean) => ({
  dataAsOf: asOf.toISOString(),
  ...(stale ? { warning: 'Live data unavailable; this is an older cached copy. Tell the user times may be outdated.' } : {}),
});

function tool<S extends z.ZodObject>(t: Tool<S>): Tool<S> {
  return t;
}

export function createTools(deps: ToolDeps): Tool[] {
  return [
    tool({
      name: 'find_stops',
      title: 'Find stops',
      description: 'Search Berlin/Brandenburg public transport stops by name. Use it when a place name is ambiguous.',
      input: z.object({ query: z.string().min(2).max(100).describe('Part of the stop name'), limit: z.number().int().min(1).max(10).optional() }),
      async run({ query, limit }) {
        const r = await deps.findStops.execute(limit === undefined ? { query } : { query, limit });
        return { stops: r.value.map((s) => ({ id: s.id, name: s.name, products: s.products })) };
      },
    }),
    tool({
      name: 'departure_board',
      title: 'Live departures',
      description: 'Live departures at a stop: line, direction, minutes until departure, delay, cancellations, platform, crowding and disruptions.',
      input: z.object({
        stop: stopParam,
        line: z.string().max(10).optional().describe('Only this line, e.g. "U8", "S41", "M10"'),
        windowMinutes: z.number().int().min(1).max(120).optional().describe('How far ahead to look, default 30'),
      }),
      async run({ stop, line, windowMinutes }) {
        const b = await deps.departureBoard.execute({
          stop, ...(line ? { line } : {}), ...(windowMinutes ? { windowMinutes } : {}), limit: 10,
        });
        return {
          stop: b.stop.name,
          departures: b.rows.map((r) => ({
            line: r.line, direction: r.direction, inMinutes: r.inMinutes, time: r.time,
            delayMinutes: r.delayMinutes, status: r.status, platform: r.platform, occupancy: r.occupancy,
          })),
          summary: b.summary,
          disruptions: b.disruptions,
          ...freshness(b.asOf, b.stale),
        };
      },
    }),
    tool({
      name: 'plan_trip',
      title: 'Plan a trip',
      description: 'Public transport connections between two stops, plus a recommendation whether the bike is the better choice right now (uses live weather).',
      input: z.object({
        from: stopParam,
        to: stopParam,
        departAt: z.string().datetime({ offset: true }).optional().describe('ISO date-time with offset. Omit for "now".'),
      }),
      async run({ from, to, departAt }) {
        const p = await deps.planTrip.execute({ from, to, ...(departAt ? { departAt } : {}) });
        return {
          from: p.from.name, to: p.to.name,
          options: p.options,
          recommendation: p.advice,
          weatherAvailable: p.weatherAvailable,
          ...freshness(p.asOf, p.stale),
        };
      },
    }),
    tool({
      name: 'weather_at_stop',
      title: 'Weather at a stop',
      description: 'Current weather near a stop: temperature, rain, rain probability for the next hour, wind.',
      input: z.object({ stop: stopParam }),
      async run({ stop }) {
        const w = await deps.weatherAtStop.execute({ stop });
        return { stop: w.stop.name, ...w.weather.value, ...freshness(w.weather.asOf, w.weather.stale) };
      },
    }),
  ] as unknown as Tool[];
}

/** Runs a tool with validated input and turns expected failures into answers the model can use. */
export async function invokeTool(tools: readonly Tool[], name: string, rawInput: unknown): Promise<ToolResult> {
  const t = tools.find((x) => x.name === name);
  if (!t) return { ok: false, error: `Unknown tool "${name}". Available: ${tools.map((x) => x.name).join(', ')}`, retryable: false };
  const parsed = t.input.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, retryable: false };
  }
  try {
    return { ok: true, data: await t.run(parsed.data) };
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof InvalidRequestError) return { ok: false, error: err.message, retryable: false };
    if (err instanceof DependencyUnavailableError) return { ok: false, error: err.message, retryable: true };
    throw err; // programming errors must surface, not be hidden from developers
  }
}
