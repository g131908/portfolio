# Working on this codebase

Rules for anyone changing this project, human or coding agent, distilled from
[ciembor/agent-rules-books](https://github.com/ciembor/agent-rules-books) (MIT).

## Architecture (Clean Architecture)

- `src/core` holds the use case, the Finding model and the assessment policy. It imports nothing outside `src/core`.
- Analyzers are pure functions over bytes. They may use parsing libraries (exifr, jpeg-js, fflate) but never the DOM, workers or the C2PA SDK.
- Platform details (WebAssembly SDK, OffscreenCanvas) live in `src/adapters` behind ports such as `ProvenanceReader`.
- `test/architecture.test.ts` enforces these rules.

## Files are hostile input (Release It!)

- Every read is bounds-checked. Never trust lengths, offsets or counts from a file.
- Bound all work: inflate only needed ZIP parts with a byte budget, cap image size, cap segment and chunk loops.
- An analyzer that fails must not break the report: `InspectFile` isolates each analyzer with a timeout and turns errors into findings and stated limitations.

## Honest evidence

- A finding states what was observed, how much it matters, and innocent explanations where they exist.
- Severity must match the evidence. Editing software is a notice, not an accusation; ELA alone never exceeds a warning.
- "No red flags" must never be presented as proof of authenticity.
- New checks need a test with a real or realistically constructed file, and a test that a clean file does not trigger them.
