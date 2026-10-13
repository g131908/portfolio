// Audio graph:
//
//  voices ─► bus ─► crusher ─► filter ─┬─► dry ───────────────┐
//                                      ├─► delay ⟲ feedback ─┤
//                                      └─► reverb (convolver) ┴─► master ─► analyser ─► out

export class Engine {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    const c = this.ctx;

    this.bus = c.createGain();
    this.crusher = c.createWaveShaper();
    this.crusher.oversample = 'none';
    this.filter = c.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 0.9;

    this.dry = c.createGain();
    this.delay = c.createDelay(2);
    this.delayFeedback = c.createGain();
    this.delaySend = c.createGain();
    this.delayTone = c.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayTone.frequency.value = 3500;

    this.reverb = c.createConvolver();
    this.reverb.buffer = this.#impulse(2.4, 2.5);
    this.reverbSend = c.createGain();

    this.master = c.createGain();
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 1024;

    this.bus.connect(this.crusher).connect(this.filter);
    this.filter.connect(this.dry).connect(this.master);
    this.filter.connect(this.delaySend).connect(this.delay);
    this.delay.connect(this.delayTone).connect(this.delayFeedback).connect(this.delay);
    this.delayTone.connect(this.master);
    this.filter.connect(this.reverbSend).connect(this.reverb).connect(this.master);
    this.master.connect(this.analyser).connect(c.destination);

    this.buffers = new Array(16).fill(null);
    this.chokeGroups = new Map(); // group id -> active source
    this.onTrigger = null;
  }

  resume() {
    return this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
  }

  get now() { return this.ctx.currentTime; }

  setBuffer(index, buffer) { this.buffers[index] = buffer; }

  async decodeFile(file) {
    const data = await file.arrayBuffer();
    return this.ctx.decodeAudioData(data);
  }

  /**
   * Play pad `index` at audio time `when`.
   * @param {number} velocity 0..1
   * @param {number|null} choke pads sharing a choke group cut each other off (hat / open hat)
   */
  play(index, when = 0, velocity = 1, choke = null) {
    const buffer = this.buffers[index];
    if (!buffer) return;
    const t = Math.max(when, this.ctx.currentTime);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = velocity;
    src.connect(gain).connect(this.bus);

    if (choke !== null) {
      const prev = this.chokeGroups.get(choke);
      if (prev) {
        prev.gain.gain.setTargetAtTime(0, t, 0.005);
        prev.src.stop(t + 0.05);
      }
      this.chokeGroups.set(choke, { src, gain });
    }

    src.start(t);
    if (this.onTrigger) {
      const delayMs = Math.max(0, (t - this.ctx.currentTime) * 1000);
      setTimeout(() => this.onTrigger(index), delayMs);
    }
  }

  // --- FX setters, all take 0..1 -------------------------------------------

  setFilter(v) {
    // exponential mapping feels natural: 80 Hz .. 20 kHz
    const f = 80 * (20000 / 80) ** v;
    this.filter.frequency.setTargetAtTime(f, this.now, 0.02);
  }

  setDelay(v, bpm) {
    this.delaySend.gain.setTargetAtTime(v * 0.6, this.now, 0.02);
    this.delayFeedback.gain.setTargetAtTime(v * 0.55, this.now, 0.02);
    this.syncDelay(bpm);
  }

  syncDelay(bpm) {
    // dotted eighth note
    this.delay.delayTime.setTargetAtTime((60 / bpm) * 0.75, this.now, 0.05);
  }

  setReverb(v) { this.reverbSend.gain.setTargetAtTime(v * 0.8, this.now, 0.02); }

  setVolume(v) { this.master.gain.setTargetAtTime(v, this.now, 0.02); }

  setCrush(v) {
    if (v <= 0.001) { this.crusher.curve = null; return; }
    // fewer quantisation steps = more grit (16 bit down to ~3 bit)
    const bits = 16 - v * 13;
    const steps = 2 ** bits;
    const n = 4096;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    this.crusher.curve = curve;
  }

  #impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
    }
    return buf;
  }
}
