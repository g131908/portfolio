import { emptyPattern, ON, ACCENT } from './sequencer.js';

/** A laid-back boom-bap groove so the app makes sound on first play. */
export function demoPattern() {
  const p = emptyPattern();
  const set = (pad, steps, v = ON) => steps.forEach((s) => { p[pad][s] = v; });
  set(0, [0, 7, 10], ACCENT);        // kick
  set(2, [4, 12], ACCENT);           // snare
  set(4, [0, 2, 4, 6, 8, 10, 12]);   // hat
  set(5, [14]);                      // open hat
  set(6, [15]);                      // rim
  set(12, [0, 10]);                  // bass
  set(14, [0]);                      // chord
  return p;
}
