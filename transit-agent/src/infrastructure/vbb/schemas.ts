// Contract for the parts of the VBB "transport.rest" v6 API we use.
// Only the fields we read are declared; unknown fields are ignored so additive API
// changes on their side do not break us (tolerant reader).

import { z } from 'zod';

const location = z.object({ latitude: z.number(), longitude: z.number() }).nullish();

export const stopSchema = z.object({
  type: z.string(),
  id: z.string(),
  name: z.string(),
  location,
  products: z.record(z.string(), z.boolean()).nullish(),
});
export type VbbStop = z.infer<typeof stopSchema>;

export const locationsSchema = z.array(
  // /locations can also return addresses and POIs; those have no stop id and are filtered later
  z.object({ type: z.string(), id: z.string().nullish(), name: z.string().nullish() }).passthrough(),
);

const remarkSchema = z.object({
  type: z.string(),
  code: z.string().nullish(),
  summary: z.string().nullish(),
  text: z.string().nullish(),
});

const lineSchema = z.object({
  name: z.string(),
  product: z.string().nullish(),
  color: z.object({ bg: z.string() }).nullish(),
});

export const departureSchema = z.object({
  tripId: z.string(),
  when: z.string().nullish(),
  plannedWhen: z.string().nullish(),
  delay: z.number().nullish(),
  platform: z.string().nullish(),
  direction: z.string().nullish(),
  cancelled: z.boolean().nullish(),
  line: lineSchema,
  remarks: z.array(remarkSchema).nullish(),
});
export type VbbDeparture = z.infer<typeof departureSchema>;

export const departuresResponseSchema = z.object({
  departures: z.array(departureSchema),
  realtimeDataUpdatedAt: z.number().nullish(),
});

const legSchema = z.object({
  origin: stopSchema.partial({ products: true, location: true }).passthrough(),
  destination: stopSchema.partial({ products: true, location: true }).passthrough(),
  departure: z.string().nullish(),
  plannedDeparture: z.string().nullish(),
  arrival: z.string().nullish(),
  plannedArrival: z.string().nullish(),
  departureDelay: z.number().nullish(),
  direction: z.string().nullish(),
  walking: z.boolean().nullish(),
  distance: z.number().nullish(),
  cancelled: z.boolean().nullish(),
  line: lineSchema.nullish(),
  remarks: z.array(remarkSchema).nullish(),
});
export type VbbLeg = z.infer<typeof legSchema>;

export const journeysResponseSchema = z.object({
  journeys: z.array(z.object({ legs: z.array(legSchema).min(1) })),
  realtimeDataUpdatedAt: z.number().nullish(),
});
