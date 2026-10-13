import { Engine } from './audio/engine.js';
import { renderKit, KITS } from './audio/synth.js';
import {
  Sequencer, STEPS, PADS, toggleStep, serialize, deserialize, clamp,
} from './sequencer.js';
import { demoPattern } from './demo-pattern.js';

const KEYS = ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'z', 'x', 'c', 'v'];
const CHOKE = { 4: 1, 5: 1 }; // closed + open hat cut each other off
const STORAGE_KEY = 'pad16-state';

const $ = (id) => document.getElementById(id);
const els = {
  start: $('btn-start'), play: $('btn-play'), clear: $('btn-clear'),
  bpm: $('bpm'), swing: $('swing'), kit: $('kit'),
  exportBtn: $('btn-export'), importInput: $('file-import'),
  pads: $('pads'), steps: $('steps'), seqPadName: $('seq-pad-name'),
  dispMain: $('disp-main'), dispPad: $('disp-pad'), dispBpm: $('disp-bpm'), dispStep: $('disp-step'),
  scope: $('scope'),
};

const state = {
  bpm: 90, swing: 0.2, kit: 'boom',
  pattern: demoPattern(),
  selected: 0,
  names: new Array(PADS).fill(''),
};

let engine = null;
let seq = null;
const padEls = [];
const stepEls = [];

// ---------------------------------------------------------------------------
// persistence (best effort — private windows may throw)

function save() {
  try { localStorage.setItem(STORAGE_KEY, serialize(state)); } catch { /* ignore */ }
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(state, deserialize(raw));
  } catch { /* ignore corrupt or unavailable storage */ }
}

// ---------------------------------------------------------------------------
// UI construction

function buildPads() {
  for (let i = 0; i < PADS; i++) {
    const b = document.createElement('button');
    b.className = 'pad';
    b.type = 'button';
    b.dataset.index = i;
    b.innerHTML = `<span class="pad-key">${KEYS[i].toUpperCase()}</span><span class="pad-name"></span>`;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      select(i);
      trigger(i);
    });
    b.addEventListener('dragover', (e) => { e.preventDefault(); b.classList.add('drop'); });
    b.addEventListener('dragleave', () => b.classList.remove('drop'));
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      b.classList.remove('drop');
      const file = e.dataTransfer.files[0];
      if (file) loadSample(i, file);
    });
    els.pads.appendChild(b);
    padEls.push(b);
  }
}

function buildSteps() {
  for (let s = 0; s < STEPS; s++) {
    const b = document.createElement('button');
    b.className = 'step';
    b.type = 'button';
    b.setAttribute('aria-label', `Step ${s + 1}`);
    if (s % 4 === 0) b.classList.add('beat');
    b.addEventListener('click', (e) => {
      const row = state.pattern[state.selected];
      row[s] = toggleStep(row[s], e.shiftKey);
      renderSteps();
      save();
    });
    els.steps.appendChild(b);
    stepEls.push(b);
  }
}

function renderPads() {
  padEls.forEach((el, i) => {
    el.querySelector('.pad-name').textContent = state.names[i] || '—';
    el.classList.toggle('selected', i === state.selected);
    el.classList.toggle('has-steps', state.pattern[i].some((v) => v > 0));
  });
}

function renderSteps() {
  const row = state.pattern[state.selected];
  stepEls.forEach((el, s) => {
    el.classList.toggle('on', row[s] > 0);
    el.classList.toggle('accent', row[s] === 1);
    el.setAttribute('aria-pressed', row[s] > 0);
  });
  els.seqPadName.textContent = `Pad ${state.selected + 1} · ${state.names[state.selected] || ''}`;
  renderPads();
}

function display(msg) { els.dispMain.textContent = msg; }

function select(i) {
  state.selected = i;
  els.dispPad.textContent = `PAD ${String(i + 1).padStart(2, '0')}`;
  renderSteps();
}

function flash(i) {
  const el = padEls[i];
  el.classList.remove('hit');
  void el.offsetWidth; // restart CSS animation
  el.classList.add('hit');
}

// ---------------------------------------------------------------------------
// audio

function trigger(i, when = 0, velocity = 1) {
  if (!engine) return;
  engine.play(i, when, velocity, CHOKE[i] ?? null);
  if (!when) display(state.names[i].toUpperCase());
}

async function loadKit(name) {
  display('LOADING KIT…');
  const sounds = await renderKit(name);
  sounds.forEach((s, i) => {
    engine.setBuffer(i, s.buffer);
    state.names[i] = s.name;
  });
  state.kit = name;
  renderSteps();
  display(`KIT: ${name.toUpperCase()}`);
}

async function loadSample(i, file) {
  if (!engine) { display('START AUDIO FIRST'); return; }
  try {
    const buf = await engine.decodeFile(file);
    engine.setBuffer(i, buf);
    state.names[i] = file.name.replace(/\.[^.]+$/, '').slice(0, 14);
    renderPads();
    display(`LOADED ${state.names[i].toUpperCase()}`);
  } catch {
    display('UNSUPPORTED FILE');
  }
}

async function start() {
  engine = new Engine();
  await engine.resume();
  engine.onTrigger = flash;

  seq = new Sequencer({
    clock: () => engine.now,
    onNote: (pad, t, v) => engine.play(pad, t, v, CHOKE[pad] ?? null),
    onStep: (step, t) => {
      const ms = Math.max(0, (t - engine.now) * 1000);
      setTimeout(() => showStep(step), ms);
    },
  });
  seq.pattern = state.pattern;
  applySettings();
  applyFx();

  await loadKit(state.kit);
  els.start.hidden = true;
  [els.play, els.clear, els.exportBtn].forEach((b) => { b.disabled = false; });
  drawScope();
}

function showStep(step) {
  els.dispStep.textContent = `STEP ${String(step + 1).padStart(2, '0')}`;
  stepEls.forEach((el, s) => el.classList.toggle('playhead', s === step && seq.playing));
}

function togglePlay() {
  if (!seq) return;
  if (seq.playing) {
    seq.stop();
    stepEls.forEach((el) => el.classList.remove('playhead'));
    display('STOPPED');
  } else {
    seq.start();
    display('PLAYING');
  }
  els.play.textContent = seq.playing ? '■ Stop' : '▶ Play';
  els.play.setAttribute('aria-pressed', seq.playing);
}

function applySettings() {
  state.bpm = clamp(Number(els.bpm.value) || 90, 40, 220);
  state.swing = Number(els.swing.value) / 100;
  els.dispBpm.textContent = `${state.bpm} BPM`;
  if (seq) { seq.bpm = state.bpm; seq.swing = state.swing; }
  if (engine) engine.syncDelay(state.bpm);
  save();
}

const fxInputs = ['filter', 'delay', 'reverb', 'crush', 'volume'];

function applyFx() {
  if (!engine) return;
  const v = Object.fromEntries(fxInputs.map((k) => [k, Number($(`fx-${k}`).value) / 100]));
  engine.setFilter(v.filter);
  engine.setDelay(v.delay, state.bpm);
  engine.setReverb(v.reverb);
  engine.setCrush(v.crush);
  engine.setVolume(v.volume);
  $('out-filter').textContent = v.filter >= 0.99 ? 'open' : `${Math.round(80 * (250 ** v.filter))} Hz`;
  ['delay', 'reverb', 'crush', 'volume'].forEach((k) => {
    $(`out-${k}`).textContent = `${Math.round(v[k] * 100)}%`;
  });
}

function drawScope() {
  const c = els.scope;
  const g = c.getContext('2d');
  const data = new Uint8Array(engine.analyser.fftSize);
  const color = getComputedStyle(document.documentElement).getPropertyValue('--lcd-ink').trim() || '#9f9';
  const loop = () => {
    engine.analyser.getByteTimeDomainData(data);
    g.clearRect(0, 0, c.width, c.height);
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / data.length) * c.width;
      const y = (data[i] / 255) * c.height;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
    requestAnimationFrame(loop);
  };
  loop();
}

// ---------------------------------------------------------------------------
// import / export

function exportPattern() {
  const blob = new Blob([serialize(state)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pad16-${state.kit}-${state.bpm}bpm.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importPattern(file) {
  try {
    const data = deserialize(await file.text());
    Object.assign(state, data);
    els.bpm.value = state.bpm;
    els.swing.value = Math.round(state.swing * 100);
    els.kit.value = state.kit;
    if (seq) seq.pattern = state.pattern;
    applySettings();
    if (engine) await loadKit(state.kit);
    renderSteps();
    display('PATTERN LOADED');
  } catch (err) {
    display(err.message.toUpperCase().slice(0, 22));
  }
}

// ---------------------------------------------------------------------------
// events

els.start.addEventListener('click', start);
els.play.addEventListener('click', togglePlay);
els.clear.addEventListener('click', () => {
  state.pattern.forEach((row) => row.fill(0));
  renderSteps();
  save();
});
els.bpm.addEventListener('change', applySettings);
els.swing.addEventListener('input', applySettings);
els.kit.addEventListener('change', () => engine && loadKit(els.kit.value).then(save));
els.exportBtn.addEventListener('click', exportPattern);
els.importInput.addEventListener('change', () => {
  const f = els.importInput.files[0];
  if (f) importPattern(f);
  els.importInput.value = '';
});
fxInputs.forEach((k) => $(`fx-${k}`).addEventListener('input', applyFx));

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select') || e.repeat || e.metaKey || e.ctrlKey) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
  const i = KEYS.indexOf(e.key.toLowerCase());
  if (i >= 0) { select(i); trigger(i); }
});

// ---------------------------------------------------------------------------
// boot

load();
KITS[state.kit].forEach((d, i) => { state.names[i] = d.name; });
els.bpm.value = state.bpm;
els.swing.value = Math.round(state.swing * 100);
els.kit.value = state.kit;
els.dispBpm.textContent = `${state.bpm} BPM`;
buildPads();
buildSteps();
select(0);
