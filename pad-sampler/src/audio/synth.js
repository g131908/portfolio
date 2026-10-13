// Drum and tone synthesis.
// Every sound is rendered once into an AudioBuffer with an OfflineAudioContext,
// so playback is cheap and synthesized sounds behave exactly like loaded samples.

const SR = 44100;

function noiseBuffer(ctx, seconds) {
  const buf = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function env(param, t, attack, peak, decay, end = 0.0001) {
  // exponential ramps cannot reach 0, so clamp to a tiny value
  const top = Math.max(peak, 0.0001);
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(top, t + attack);
  param.exponentialRampToValueAtTime(end, t + attack + decay);
}

// --- voice recipes: (ctx, out, opts) => void -------------------------------

const recipes = {
  kick(ctx, out, { tune = 1, decay = 0.45, click = 0.6 } = {}) {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.frequency.setValueAtTime(150 * tune, 0);
    osc.frequency.exponentialRampToValueAtTime(45 * tune, 0.12);
    env(amp.gain, 0, 0.002, 1, decay);
    osc.connect(amp).connect(out);
    osc.start(0);
    osc.stop(decay + 0.05);

    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 0.02);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    const ng = ctx.createGain();
    env(ng.gain, 0, 0.001, click, 0.015);
    n.connect(hp).connect(ng).connect(out);
    n.start(0);
  },

  snare(ctx, out, { tone = 190, decay = 0.22, snap = 0.8 } = {}) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(tone, 0);
    osc.frequency.exponentialRampToValueAtTime(tone * 0.6, 0.1);
    const og = ctx.createGain();
    env(og.gain, 0, 0.001, 0.7, 0.12);
    osc.connect(og).connect(out);
    osc.start(0);
    osc.stop(0.2);

    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, decay + 0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2500;
    bp.Q.value = 0.7;
    const ng = ctx.createGain();
    env(ng.gain, 0, 0.001, snap, decay);
    n.connect(bp).connect(ng).connect(out);
    n.start(0);
  },

  clap(ctx, out, { decay = 0.25 } = {}) {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, decay + 0.1);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    // three short bursts then a tail = the classic hand-clap smear
    [0, 0.012, 0.024].forEach((t) => {
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.1, t + 0.01);
    });
    g.gain.setValueAtTime(0.7, 0.036);
    g.gain.exponentialRampToValueAtTime(0.0001, 0.036 + decay);
    n.connect(bp).connect(g).connect(out);
    n.start(0);
  },

  hat(ctx, out, { decay = 0.06, level = 0.5 } = {}) {
    // metallic hat from six detuned square waves (808 style)
    const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
    const mix = ctx.createGain();
    mix.gain.value = 0.25;
    ratios.forEach((r) => {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 40 * r;
      o.connect(mix);
      o.start(0);
      o.stop(decay + 0.05);
    });
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    env(g.gain, 0, 0.001, level, decay);
    mix.connect(hp).connect(g).connect(out);
  },

  tom(ctx, out, { freq = 120, decay = 0.35 } = {}) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(freq * 1.6, 0);
    o.frequency.exponentialRampToValueAtTime(freq, 0.08);
    const g = ctx.createGain();
    env(g.gain, 0, 0.002, 0.8, decay);
    o.connect(g).connect(out);
    o.start(0);
    o.stop(decay + 0.05);
  },

  rim(ctx, out) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 1700;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1700;
    bp.Q.value = 6;
    const g = ctx.createGain();
    env(g.gain, 0, 0.001, 0.8, 0.03);
    o.connect(bp).connect(g).connect(out);
    o.start(0);
    o.stop(0.06);
  },

  bass(ctx, out, { note = 36, decay = 0.6 } = {}) {
    const f = 440 * 2 ** ((note - 69) / 12);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const sub = ctx.createOscillator();
    sub.frequency.value = f / 2;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(1800, 0);
    lp.frequency.exponentialRampToValueAtTime(180, decay * 0.7);
    const g = ctx.createGain();
    env(g.gain, 0, 0.005, 0.6, decay);
    o.connect(lp);
    sub.connect(lp);
    lp.connect(g).connect(out);
    [o, sub].forEach((x) => { x.start(0); x.stop(decay + 0.05); });
  },

  chord(ctx, out, { notes = [57, 60, 64, 67], decay = 1.2, wobble = 0 } = {}) {
    const g = ctx.createGain();
    env(g.gain, 0, 0.02, 0.35, decay);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    notes.forEach((n, i) => {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'triangle' : 'sawtooth';
      o.frequency.value = 440 * 2 ** ((n - 69) / 12);
      o.detune.value = (i - 1.5) * 6;
      if (wobble) {
        // tape-style pitch wobble
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.value = 0.7;
        depth.gain.value = wobble;
        lfo.connect(depth).connect(o.detune);
        lfo.start(0);
        lfo.stop(decay + 0.1);
      }
      o.connect(lp);
      o.start(0);
      o.stop(decay + 0.1);
    });
    lp.connect(g).connect(out);
  },

  perc(ctx, out, { freq = 800, decay = 0.12 } = {}) {
    // two-operator FM blip
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    car.frequency.value = freq;
    mod.frequency.value = freq * 1.41;
    modGain.gain.setValueAtTime(freq * 2, 0);
    modGain.gain.exponentialRampToValueAtTime(1, decay);
    mod.connect(modGain).connect(car.frequency);
    const g = ctx.createGain();
    env(g.gain, 0, 0.001, 0.6, decay);
    car.connect(g).connect(out);
    [car, mod].forEach((x) => { x.start(0); x.stop(decay + 0.05); });
  },

  vinyl(ctx, out, { length = 1.5 } = {}) {
    // crackle: sparse impulses through a bandpass
    const buf = ctx.createBuffer(1, Math.ceil(length * ctx.sampleRate), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      d[i] = Math.random() < 0.0008 ? (Math.random() * 2 - 1) : (Math.random() * 2 - 1) * 0.01;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3000;
    const g = ctx.createGain();
    g.gain.value = 0.8;
    src.connect(bp).connect(g).connect(out);
    src.start(0);
  },
};

// --- kits: 16 pad definitions each -----------------------------------------

export const KITS = {
  boom: [
    { name: 'Kick', recipe: 'kick', opts: { tune: 1, decay: 0.5 } },
    { name: 'Kick 2', recipe: 'kick', opts: { tune: 0.85, decay: 0.7, click: 0.3 } },
    { name: 'Snare', recipe: 'snare' },
    { name: 'Clap', recipe: 'clap' },
    { name: 'Hat', recipe: 'hat' },
    { name: 'Open Hat', recipe: 'hat', opts: { decay: 0.3, level: 0.4 } },
    { name: 'Rim', recipe: 'rim' },
    { name: 'Snare 2', recipe: 'snare', opts: { tone: 230, decay: 0.12, snap: 1 } },
    { name: 'Tom Lo', recipe: 'tom', opts: { freq: 90 } },
    { name: 'Tom Hi', recipe: 'tom', opts: { freq: 150, decay: 0.25 } },
    { name: 'Perc', recipe: 'perc' },
    { name: 'Perc 2', recipe: 'perc', opts: { freq: 520, decay: 0.2 } },
    { name: 'Bass C', recipe: 'bass', opts: { note: 36 } },
    { name: 'Bass Eb', recipe: 'bass', opts: { note: 39 } },
    { name: 'Chord Am7', recipe: 'chord', opts: { notes: [57, 60, 64, 67] } },
    { name: 'Chord Fmaj7', recipe: 'chord', opts: { notes: [53, 57, 60, 64] } },
  ],
  lofi: [
    { name: 'Dusty Kick', recipe: 'kick', opts: { tune: 0.9, decay: 0.35, click: 0.2 } },
    { name: 'Thump', recipe: 'kick', opts: { tune: 0.7, decay: 0.9, click: 0 } },
    { name: 'Soft Snare', recipe: 'snare', opts: { tone: 170, decay: 0.3, snap: 0.5 } },
    { name: 'Clap', recipe: 'clap', opts: { decay: 0.4 } },
    { name: 'Shaker', recipe: 'hat', opts: { decay: 0.04, level: 0.3 } },
    { name: 'Hat', recipe: 'hat', opts: { decay: 0.12, level: 0.35 } },
    { name: 'Rim', recipe: 'rim' },
    { name: 'Crackle', recipe: 'vinyl' },
    { name: 'Tom', recipe: 'tom', opts: { freq: 110, decay: 0.5 } },
    { name: 'Bell', recipe: 'perc', opts: { freq: 1046, decay: 0.6 } },
    { name: 'Blip', recipe: 'perc', opts: { freq: 660, decay: 0.08 } },
    { name: 'Wood', recipe: 'perc', opts: { freq: 300, decay: 0.05 } },
    { name: 'Bass D', recipe: 'bass', opts: { note: 38, decay: 0.9 } },
    { name: 'Bass F', recipe: 'bass', opts: { note: 41, decay: 0.9 } },
    { name: 'Keys Dm9', recipe: 'chord', opts: { notes: [50, 53, 57, 60, 64], decay: 1.8, wobble: 12 } },
    { name: 'Keys Gm7', recipe: 'chord', opts: { notes: [55, 58, 62, 65], decay: 1.8, wobble: 12 } },
  ],
};

/** Render one pad definition into an AudioBuffer. */
export async function renderPad(def, seconds = 2) {
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const recipe = recipes[def.recipe];
  if (!recipe) throw new Error(`Unknown recipe: ${def.recipe}`);
  recipe(ctx, out, def.opts);
  return trimSilence(await ctx.startRendering());
}

/** Drop trailing near-silence so buffers stay small and choke cleanly. */
function trimSilence(buffer, threshold = 0.0005) {
  const data = buffer.getChannelData(0);
  let end = data.length - 1;
  while (end > 0 && Math.abs(data[end]) < threshold) end--;
  const len = Math.max(1, end + 1);
  if (len === data.length) return buffer;
  const out = new AudioBuffer({ length: len, sampleRate: buffer.sampleRate, numberOfChannels: 1 });
  out.copyToChannel(data.subarray(0, len), 0);
  return out;
}

export async function renderKit(name) {
  const defs = KITS[name];
  return Promise.all(defs.map(async (d) => ({ name: d.name, buffer: await renderPad(d) })));
}
