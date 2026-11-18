# Working on this codebase

Rules for anyone changing this project, human or coding agent. They are distilled from the rule sets in
[ciembor/agent-rules-books](https://github.com/ciembor/agent-rules-books) (MIT), which the project was built with.

## Architecture (Clean Architecture)

- `src/core` contains business rules only. It must not import anything outside `src/core`: no zod, no fetch, no MCP, no DOM.
- The core owns its ports (`TransitGateway`, `WeatherGateway`, `Clock`). Infrastructure implements them.
- Adapters translate formats and map errors. Business decisions (filtering departed trains, the bike policy, summaries) belong in the core.
- Only `src/composition.ts` instantiates concrete classes.
- `test/architecture.test.ts` enforces these rules. Do not weaken it to make a change pass.

## Calling external systems (Release It!)

- Every outbound call goes through `DependencyClient`. Do not call `fetch` directly from a gateway.
- Keep explicit timeouts, bounded retries and a total time budget. Retry only transient failures (network, timeout, 5xx, 429).
- Client errors (4xx) must not trip the circuit breaker.
- Every queue, cache, history and output stays bounded.

## Data (Designing Data-Intensive Applications)

- The VBB API is the source of truth. Anything we hold is a derived copy with `asOf` and `stale`; never drop these fields.
- Validate every external response with a zod schema before it reaches the cache or the domain. Declare only the fields we read.
- When serving stale data, the user must be told: UI badge, `warning` field in tool output.

## Design (A Philosophy of Software Design)

- Prefer deep modules with simple interfaces. A new wrapper must hide real complexity.
- Name things after the domain: `punctuality`, `bestKnownTime`, not `processData`.

## Workflow

- Add or update tests first for core behaviour. Core tests use fakes, never the network.
- New upstream fields: record a real response into `test/fixtures` and extend the contract test.
- Run `npm test` and `npm run typecheck` before committing.
