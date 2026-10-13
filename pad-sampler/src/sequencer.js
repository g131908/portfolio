// Look-ahead step sequencer.
// A coarse JS timer wakes up every `interval` ms and schedules every step that
// falls inside the next `lookahead` seconds on the precise audio clock.
// This keeps timing tight even when the main thread is busy.

export const STEPS = 16;
export const PADS = 16;

/** Velocity values stored per step. 0 = off. */
export const OFF = 0;
export const ON = 0.75;
export const ACCENT = 1;

export function emptyPattern() {
  return Array.from({ length: PADS }, () => new Array(STEPS).fill(OFF));
}

/** Seconds per 16th note. */
export function stepDuration(bpm) {
  return 60 / bpm / 4;
}

/**
 * Offset for swung 16ths: every odd step is pushed later.
 * swing 0..1 -> 0 .. 1/3 of a step (1/3 = full triplet feel).
 */
export function swingOffset(step, bpm, swing) {
  return step % 2 === 1 ? stepDuration(bpm) * (swing / 3) : 0;
}

/** Cycle a step: off -> on -> off, or with accent: any -> accent -> off. */
export function toggleStep(value, accent = false) {
  if (accent) return value === ACCENT ? OFF : ACCENT;
  return value === OFF ? ON : OFF;
}

export function serialize(state) {
  return JSON.stringify({
    format: 'pad16-pattern',
    version: 1,
    bpm: state.bpm,
    swing: state.swing,
    kit: state.kit,
    pattern: state.pattern,
  }, null, 2);
}

export function deserialize(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (data.format !== 'pad16-pattern') throw new Error('Not a PAD-16 pattern file');
  const { pattern } = data;
  const valid = Array.isArray(pattern) && pattern.length === PADS
    && pattern.every((row) => Array.isArray(row) && row.length === STEPS
      && row.every((v) => typeof v === 'number' && v >= 0 && v <= 1));
  if (!valid) throw new Error('Pattern has the wrong shape');
  return {
    bpm: clamp(Number(data.bpm) || 90, 40, 220),
    swing: clamp(Number(data.swing) || 0, 0, 1),
    kit: data.kit || 'boom',
    pattern,
  };
}

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export class Sequencer {
  /**
   * @param {object} opts
   * @param {() => number} opts.clock      current audio time in seconds
   * @param {(pad:number, time:number, velocity:number) => void} opts.onNote
   * @param {(step:number, time:number) => void} [opts.onStep]
   */
  constructor({ clock, onNote, onStep = () => {}, lookahead = 0.1, interval = 25 }) {
    this.clock = clock;
    this.onNote = onNote;
    this.onStep = onStep;
    this.lookahead = lookahead;
    this.interval = interval;
    this.bpm = 90;
    this.swing = 0;
    this.pattern = emptyPattern();
    this.playing = false;
    this.step = 0;
    this.nextTime = 0;
    this.timer = null;
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    this.step = 0;
    this.nextTime = this.clock() + 0.05;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.interval);
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Schedule all steps up to clock() + lookahead. Public for testing. */
  tick() {
    const horizon = this.clock() + this.lookahead;
    while (this.nextTime < horizon) {
      const t = this.nextTime + swingOffset(this.step, this.bpm, this.swing);
      for (let pad = 0; pad < PADS; pad++) {
        const v = this.pattern[pad][this.step];
        if (v > 0) this.onNote(pad, t, v);
      }
      this.onStep(this.step, t);
      this.nextTime += stepDuration(this.bpm);
      this.step = (this.step + 1) % STEPS;
    }
  }
}
