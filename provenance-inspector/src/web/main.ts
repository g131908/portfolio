// UI thread: file intake, worker orchestration, C2PA verification and report rendering.

import { C2paWebReader } from '../adapters/c2pa-web-reader.js';
import { createProvenanceAnalyzer } from '../analyzers/provenance.js';
import { extendReport, type InspectionReport } from '../core/inspect-file.js';
import type { Category, Finding, Severity } from '../core/findings.js';
import type { FilePayload, FromWorker, Heatmap, ToWorker } from './protocol.js';
import { SAMPLES } from './samples.js';
import { ABOUT_HTML } from './about.js';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// --- worker + C2PA -------------------------------------------------------------------------
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, (m: FromWorker) => void>();
let nextId = 1;
worker.onmessage = (e: MessageEvent<FromWorker>) => { pending.get(e.data.id)?.(e.data); pending.delete(e.data.id); };
type Request = ToWorker extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never;
function ask(msg: Request, transfer: Transferable[]): Promise<FromWorker> {
  const id = nextId++;
  return new Promise((resolve) => { pending.set(id, resolve); worker.postMessage({ ...msg, id }, transfer); });
}

const c2pa = new C2paWebReader();
const provenance = createProvenanceAnalyzer(c2pa);
const C2PA_TIMEOUT_MS = 45_000;

async function toPayload(f: File): Promise<FilePayload> {
  return { name: f.name, type: f.type, lastModified: f.lastModified, buffer: await f.arrayBuffer() };
}

// --- inspect --------------------------------------------------------------------------------
const reportEl = $('#report');
let currentUrl: string | null = null;
let lastReport: InspectionReport | null = null;

async function inspect(file: File) {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif)$/i.test(file.name) ? URL.createObjectURL(file) : null;
  reportEl.innerHTML = `<div class="card progress"><p class="loading">Analysing <strong>${esc(file.name)}</strong>…</p><ol id="steps"></ol></div>`;
  reportEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const payload = await toPayload(file);
  const c2paBytes = new Uint8Array(payload.buffer.slice(0)); // the worker takes ownership of the original buffer
  const res = await ask({ kind: 'inspect', file: payload }, [payload.buffer]);
  if (res.kind === 'error') { reportEl.innerHTML = `<p class="banner bad" role="alert">${esc(res.message)}</p>`; return; }
  if (res.kind !== 'report') return;
  let report = res.report;
  renderReport(report, res.ela, true);

  // Content credentials need the WebAssembly SDK; run it after the fast checks are shown.
  const ctx = { ...report.file, name: file.name, declaredType: file.type, bytes: c2paBytes, lastModified: file.lastModified };
  if (provenance.appliesTo({ ...ctx, detectedType: report.file.detectedType })) {
    const started = performance.now();
    let status: 'ok' | 'failed' | 'timeout' = 'ok';
    let findings: Finding[] = [];
    try {
      findings = await Promise.race([
        provenance.analyze({ ...ctx, detectedType: report.file.detectedType }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), C2PA_TIMEOUT_MS)),
      ]);
    } catch (err) {
      status = (err as Error).message === 'timeout' ? 'timeout' : 'failed';
      console.warn('C2PA check failed', err);
    }
    report = extendReport(report, { findings, analyzer: { id: 'provenance', label: 'Content credentials (C2PA)', status, ms: Math.round(performance.now() - started) } });
    if (c2pa.trustListLoaded === false) {
      report = { ...report, assessment: { ...report.assessment, limitations: [...report.assessment.limitations, 'The C2PA trust list could not be loaded, so signers cannot be recognised as trusted.'] } };
    }
  }
  renderReport(report, res.ela, false);
}

const VERDICT_CLASS: Record<string, string> = {
  dangerous: 'bad', 'ai-generated': 'ai', 'manipulation-likely': 'bad', 'needs-review': 'warn', 'verified-provenance': 'good', 'no-red-flags': 'neutral',
};
const VERDICT_ICON: Record<string, string> = {
  dangerous: '⛔', 'ai-generated': '🤖', 'manipulation-likely': '⚠️', 'needs-review': '🔎', 'verified-provenance': '✅', 'no-red-flags': '✓',
};
const CATEGORY_LABEL: Record<Category, string> = {
  'file-type': 'File type', 'active-content': 'Active content', structure: 'Structure', metadata: 'Metadata',
  provenance: 'Content credentials', forensics: 'Image forensics', integrity: 'Fingerprint',
};
const CATEGORY_ORDER: Category[] = ['file-type', 'active-content', 'provenance', 'metadata', 'forensics', 'structure', 'integrity'];
const SEV_LABEL: Record<Severity, string> = { critical: 'critical', warning: 'warning', notice: 'notice', info: 'info' };

function findingHtml(f: Finding): string {
  const data = f.data ? Object.entries(f.data).filter(([, v]) => v !== null && v !== '') : [];
  return `
    <li class="finding sev-${f.severity}">
      <span class="sev">${SEV_LABEL[f.severity]}</span>
      <div>
        <p class="f-title">${esc(f.title)}</p>
        <p class="f-detail">${esc(f.detail)}</p>
        ${data.length ? `<dl class="kv">${data.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      </div>
    </li>`;
}

function renderReport(r: InspectionReport, ela: Heatmap | null, partial: boolean) {
  lastReport = r;
  const a = r.assessment;
  const grouped = CATEGORY_ORDER
    .map((c) => [c, r.findings.filter((f) => f.category === c)] as const)
    .filter(([, list]) => list.length);
  const imagePanel = currentUrl ? `
    <section class="card media" aria-label="Image and error level analysis">
      <div class="media-head">
        <h3>Image</h3>
        ${ela ? `<label class="toggle">Error level heatmap <input type="range" id="ela-mix" min="0" max="100" value="0" aria-label="Heatmap opacity"></label>` : ''}
      </div>
      <div class="stage" id="stage">
        <img src="${currentUrl}" alt="Inspected image" id="preview">
        ${ela ? `<canvas id="ela" width="${ela.width}" height="${ela.height}" aria-hidden="true"></canvas>` : ''}
        ${ela?.hotspot ? `<div class="hotspot" style="left:${(ela.hotspot.x / ela.width) * 100}%;top:${(ela.hotspot.y / ela.height) * 100}%;width:${(ela.hotspot.w / ela.width) * 100}%;height:${(ela.hotspot.h / ela.height) * 100}%"></div>` : ''}
      </div>
      ${ela ? '<p class="muted small">Bright areas changed most when the image was re-saved. Edges and text are always bright; a bright patch in a flat area deserves attention.</p>' : ''}
    </section>` : '';

  reportEl.innerHTML = `
    <article class="card verdict v-${VERDICT_CLASS[a.verdict]}">
      <div class="verdict-head">
        <span class="verdict-icon" aria-hidden="true">${VERDICT_ICON[a.verdict]}</span>
        <div>
          <p class="eyebrow">${esc(r.file.name)} · ${fmtBytes(r.file.size)} · ${esc(r.file.detectedType.label)}</p>
          <h2>${esc(a.headline)}</h2>
        </div>
      </div>
      <p>${esc(a.explanation)}</p>
      ${a.keyFindings.length ? `<ul class="key">${a.keyFindings.slice(0, 4).map((f) => `<li>${esc(f.title)}</li>`).join('')}</ul>` : ''}
      <div class="counts">
        ${(['critical', 'warning', 'notice', 'info'] as const).map((s) => `<span class="count sev-${s}"><strong>${a.counts[s]}</strong> ${s}</span>`).join('')}
        ${partial ? '<span class="count loading">verifying content credentials…</span>' : `<button class="btn" id="export">Export report (JSON)</button>`}
      </div>
      ${a.limitations.length ? `<p class="limits">Limits: ${a.limitations.map(esc).join(' ')}</p>` : ''}
    </article>
    <div class="report-grid ${currentUrl ? '' : 'no-media'}">
      ${imagePanel}
      <div class="groups">
        ${grouped.map(([c, list]) => `
          <section class="card group">
            <h3>${CATEGORY_LABEL[c]}</h3>
            <ul class="findings">${list.map(findingHtml).join('')}</ul>
          </section>`).join('')}
        <details class="card checks">
          <summary>${r.analyzers.filter((x) => x.status !== 'skipped').length} checks ran</summary>
          <ul>${r.analyzers.map((x) => `<li><span class="st st-${x.status}">${x.status}</span> ${esc(x.label)} ${x.status === 'skipped' ? '' : `<span class="muted">${x.ms} ms</span>`}</li>`).join('')}</ul>
        </details>
      </div>
    </div>`;

  if (ela) {
    const canvas = reportEl.querySelector<HTMLCanvasElement>('#ela')!;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(ela.buffer.slice(0)), ela.width, ela.height), 0, 0);
    const mix = reportEl.querySelector<HTMLInputElement>('#ela-mix')!;
    const apply = () => { canvas.style.opacity = String(Number(mix.value) / 100); };
    mix.addEventListener('input', apply);
    apply();
  }
  reportEl.querySelector('#export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), tool: 'Provenance Inspector', ...lastReport }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${r.file.name.replace(/[^\w.-]+/g, '_')}.report.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
}

// --- file intake --------------------------------------------------------------------------
function wireDrop(zone: HTMLElement, input: HTMLInputElement, onFile: (f: File) => void) {
  input.addEventListener('change', () => { const f = input.files?.[0]; if (f) onFile(f); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const f = e.dataTransfer?.files[0];
    if (f) onFile(f);
  });
}
wireDrop($('#drop'), $<HTMLInputElement>('#file'), (f) => void inspect(f));

$('#samples').innerHTML = SAMPLES.map((s) => `<button class="sample" data-sample="${s.id}"><strong>${esc(s.label)}</strong><span>${esc(s.hint)}</span></button>`).join('');
$('#samples').addEventListener('click', async (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-sample]')?.dataset['sample'];
  const s = SAMPLES.find((x) => x.id === id);
  if (!s) return;
  try { await inspect(await s.load()); } catch (err) { reportEl.innerHTML = `<p class="banner bad">${esc((err as Error).message)}</p>`; }
});

// --- compare ---------------------------------------------------------------------------------
const chosen: { a: File | null; b: File | null } = { a: null, b: null };
const compareOut = $('#compare-out');
const VERDICT_TEXT = {
  'identical-file': ['good', 'Bit-for-bit identical', 'Both files are exactly the same file.'],
  'same-picture': ['good', 'Same picture', 'The files differ (e.g. re-compressed or resized), but the visible content is the same.'],
  modified: ['warn', 'Modified copy', 'The copy shows the same scene, but parts of the picture were changed or it was cropped.'],
  'different-picture': ['bad', 'Different picture', 'These are not the same image.'],
} as const;

async function runCompare() {
  if (!chosen.a || !chosen.b) return;
  compareOut.innerHTML = '<p class="loading">Comparing…</p>';
  const [a, b] = await Promise.all([toPayload(chosen.a), toPayload(chosen.b)]);
  const res = await ask({ kind: 'compare', a, b }, [a.buffer, b.buffer]);
  if (res.kind === 'error') { compareOut.innerHTML = `<p class="banner bad" role="alert">Could not compare: ${esc(res.message)}</p>`; return; }
  if (res.kind !== 'comparison') return;
  const c = res.comparison;
  const [cls, title, text] = VERDICT_TEXT[c.verdict];
  const urlA = URL.createObjectURL(chosen.a);
  const urlB = URL.createObjectURL(chosen.b);
  compareOut.innerHTML = `
    <article class="card verdict v-${cls}">
      <h2>${title}</h2><p>${text}</p>
      <dl class="kv">
        <div><dt>perceptual hash distance</dt><dd>${c.hashDistance} / 64</dd></div>
        <div><dt>changed area</dt><dd>${(c.changedShare * 100).toFixed(1)} %</dd></div>
        <div><dt>sizes</dt><dd>${c.sizeA} vs ${c.sizeB}${c.aspectChanged ? ' (cropped)' : ''}</dd></div>
      </dl>
    </article>
    <div class="triptych">
      <figure><img src="${urlA}" alt="Original"><figcaption>Original</figcaption></figure>
      <figure><img src="${urlB}" alt="Suspicious copy"><figcaption>Copy</figcaption></figure>
      <figure><div class="stage"><canvas id="diff" width="${res.diff.width}" height="${res.diff.height}"></canvas>
        ${c.changedBox ? `<div class="hotspot" style="left:${c.changedBox.x * 100}%;top:${c.changedBox.y * 100}%;width:${c.changedBox.w * 100}%;height:${c.changedBox.h * 100}%"></div>` : ''}</div>
        <figcaption>Differences (bright = changed)</figcaption></figure>
    </div>`;
  compareOut.querySelector<HTMLCanvasElement>('#diff')!.getContext('2d')!
    .putImageData(new ImageData(new Uint8ClampedArray(res.diff.buffer), res.diff.width, res.diff.height), 0, 0);
}
wireDrop($('#drop-a'), $<HTMLInputElement>('#file-a'), (f) => { chosen.a = f; $('#name-a').textContent = f.name; void runCompare(); });
wireDrop($('#drop-b'), $<HTMLInputElement>('#file-b'), (f) => { chosen.b = f; $('#name-b').textContent = f.name; void runCompare(); });

// --- tabs ---------------------------------------------------------------------------------
$('#panel-about').innerHTML = ABOUT_HTML;
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
function select(tab: HTMLButtonElement) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
  }
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => select(t));
  t.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (d) { const n = tabs[(i + d + tabs.length) % tabs.length]!; n.focus(); select(n); }
  });
});
