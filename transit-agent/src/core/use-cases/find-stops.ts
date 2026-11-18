import type { Stop } from '../domain/transit.js';
import { InvalidRequestError, NotFoundError, type Observed, type TransitGateway } from '../ports.js';

export interface FindStopsRequest {
  readonly query: string;
  readonly limit?: number;
}

const STOP_ID = /^\d{9}$/;
const MAX_RESULTS = 10;

export class FindStops {
  constructor(private readonly transit: TransitGateway) {}

  async execute(req: FindStopsRequest): Promise<Observed<Stop[]>> {
    const query = req.query.trim();
    if (query.length < 2) throw new InvalidRequestError('Stop query needs at least 2 characters');
    if (query.length > 100) throw new InvalidRequestError('Stop query is too long');
    const limit = Math.min(Math.max(req.limit ?? 5, 1), MAX_RESULTS);
    return this.transit.searchStops(query, limit);
  }

  /**
   * Accepts either a 9-digit VBB stop id or a free-text name ("Alexanderplatz") and returns one stop.
   * Lets agents and users talk in names while the gateway works with ids.
   */
  async resolve(nameOrId: string): Promise<Stop> {
    const input = nameOrId.trim();
    if (STOP_ID.test(input)) return (await this.transit.stopById(input)).value;
    const { value } = await this.execute({ query: input, limit: 1 });
    const best = value[0];
    if (!best) throw new NotFoundError(`No stop found for "${input}"`);
    return best;
  }
}
