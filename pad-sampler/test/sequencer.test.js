import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Sequencer, emptyPattern, stepDuration, swingOffset, toggleStep,
  serialize, deserialize, ON, ACCENT, OFF, STEPS,
} from '../src/sequencer.js';

test('a 16th note at 120 BPM lasts 125 ms', () => {
  assert.equal(stepDuration(120), 0.125);
});

test('swing only delays odd steps', () => {
  assert.equal(swingOffset(0, 120, 1), 0);
  assert.equal(swingOffset(2, 120, 1), 0);
  assert.ok(Math.abs(swingOffset(1, 120, 1) - 0.125 / 3) < 1e-9);
});

test('toggleStep cycles normal and accent states', () => {
  assert.equal(toggleStep(OFF), ON);
  assert.equal(toggleStep(ON), OFF);
  assert.equal(toggleStep(OFF, true), ACCENT);
  assert.equal(toggleStep(ACCENT, true), OFF);
});

test('serialize -> deserialize round-trips a pattern', () => {
  const pattern = emptyPattern();
  pattern[3][7] = ACCENT;
  const back = deserialize(serialize({ bpm: 95, swing: 0.2, kit: 'lofi', pattern }));
  assert.equal(back.bpm, 95);
  assert.equal(back.kit, 'lofi');
  assert.equal(back.pattern[3][7], ACCENT);
});

test('deserialize rejects foreign or malformed files', () => {
  assert.throws(() => deserialize({ format: 'other' }), /Not a PAD-16/);
  assert.throws(() => deserialize({ format: 'pad16-pattern', pattern: [[1]] }), /wrong shape/);
});

test('scheduler fires notes on the audio clock with correct timing', () => {
  let now = 0;
  const notes = [];
  const seq = new Sequencer({
    clock: () => now,
    onNote: (pad, t, v) => notes.push({ pad, t, v }),
    lookahead: 0.1,
  });
  seq.bpm = 120;
  seq.pattern[0][0] = ON;
  seq.pattern[0][4] = ON;
  seq.nextTime = 0;
  seq.playing = true;
  // advance a full bar in 25 ms ticks, like setInterval would
  for (now = 0; now <= 2; now += 0.025) seq.tick();
  const kick = notes.filter((n) => n.pad === 0).map((n) => n.t);
  assert.deepEqual(kick.slice(0, 3), [0, 0.5, 2]);
});

test('scheduler wraps around after the last step', () => {
  let now = 0;
  const seq = new Sequencer({ clock: () => now, onNote: () => {} });
  seq.bpm = 120;
  seq.nextTime = 0;
  now = STEPS * stepDuration(120) - 0.11;
  seq.tick();
  assert.equal(seq.step, 0);
});
