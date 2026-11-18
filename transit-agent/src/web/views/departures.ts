import type { DepartureBoard, Services } from '../../composition.js';
import { ago, errorText, esc, lineBadge, prefs } from '../dom.js';
import { stopInput, wireSuggestions } from '../stop-input.js';

const REFRESH_MS = 30_000;

const STATUS_LABEL: Record<string, string> = {
  'on-time': 'on time', 'slightly-late': 'delayed', late: 'late', cancelled: 'cancelled', 'no-live-data': 'scheduled',
};

function occupancyDots(o: string): string {
  const n = { low: 1, medium: 2, high: 3 }[o];
  if (!n) return '';
  return `<span class="occ occ-${esc(o)}" title="${esc(o)} occupancy expected">${'●'.repeat(n)}${'○'.repeat(3 - n)}</span>`;
}

function renderBoard(b: DepartureBoard): string {
  if (!b.rows.length) return '<p class="empty">No departures in this time window.</p>';
  return `
    ${b.disruptions.length ? `<div class="banner warn" role="status"><strong>Disruptions</strong><ul>${b.disruptions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>` : ''}
    <div class="board-meta">
      <span><strong>${b.summary.total}</strong> departures</span>
      <span><strong>${b.summary.delayed}</strong> delayed</span>
      <span><strong>${b.summary.cancelled}</strong> cancelled</span>
      <span>avg delay <strong>${b.summary.averageDelayMinutes}</strong> min</span>
    </div>
    <table class="board">
      <thead><tr><th scope="col">Line</th><th scope="col">Direction</th><th scope="col" class="hide-sm">Platform</th><th scope="col">Time</th><th scope="col" class="num">In</th></tr></thead>
      <tbody>
        ${b.rows.map((r) => `
          <tr class="${r.status === 'cancelled' ? 'cancelled' : ''}">
            <td>${lineBadge(r.line, r.product, r.color)}</td>
            <td class="dir">${esc(r.direction)} ${occupancyDots(r.occupancy)}</td>
            <td class="hide-sm">${esc(r.platform ?? '–')}</td>
            <td><span class="time">${esc(r.time)}</span>
              <span class="status s-${esc(r.status)}">${esc(STATUS_LABEL[r.status])}${r.delayMinutes ? ` +${r.delayMinutes}` : ''}</span></td>
            <td class="num big">${r.status === 'cancelled' ? '✕' : r.inMinutes === 0 ? 'now' : `${r.inMinutes}<small>min</small>`}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

export function mountDepartures(root: HTMLElement, services: Services): { onShow(): void; onHide(): void } {
  root.innerHTML = `
    <form class="toolbar" id="dep-form">
      ${stopInput('Stop', 'stop', prefs.get('board-stop', 'Alexanderplatz'))}
      <label class="field small">Line <input name="line" placeholder="all" maxlength="8" spellcheck="false"></label>
      <button class="btn primary" type="submit">Show</button>
    </form>
    <div class="freshness" id="dep-fresh" aria-live="polite"></div>
    <div id="dep-board" aria-live="polite" aria-busy="false"></div>`;

  const form = root.querySelector<HTMLFormElement>('#dep-form')!;
  const boardEl = root.querySelector<HTMLElement>('#dep-board')!;
  const freshEl = root.querySelector<HTMLElement>('#dep-fresh')!;
  wireSuggestions(root, services.findStops);

  let timer: ReturnType<typeof setInterval> | undefined;
  let last: DepartureBoard | null = null;
  let loading = false;

  const showFreshness = () => {
    if (!last) { freshEl.textContent = ''; return; }
    freshEl.innerHTML = `<h2>${esc(last.stop.name)}</h2>`
      + (last.stale
        ? `<span class="pill warn">Live data unavailable · showing copy from ${esc(ago(last.asOf))}</span>`
        : `<span class="pill ok">Live · updated ${esc(ago(last.asOf))}</span>`);
  };

  async function load() {
    if (loading) return; // never stack refreshes on a slow network
    const data = new FormData(form);
    const stop = String(data.get('stop') ?? '').trim();
    const line = String(data.get('line') ?? '').trim();
    if (stop.length < 2) return;
    loading = true;
    boardEl.setAttribute('aria-busy', 'true');
    if (!last) boardEl.innerHTML = '<p class="loading">Loading live departures…</p>';
    try {
      last = await services.departureBoard.execute({ stop, ...(line ? { line } : {}), limit: 14 });
      prefs.set('board-stop', stop);
      boardEl.innerHTML = renderBoard(last);
    } catch (err) {
      last = null;
      boardEl.innerHTML = `<p class="banner error" role="alert">${esc(errorText(err))}</p>`;
    } finally {
      loading = false;
      boardEl.setAttribute('aria-busy', 'false');
      showFreshness();
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); last = null; void load(); });
  setInterval(showFreshness, 5_000);

  return {
    onShow() {
      void load();
      clearInterval(timer);
      // refresh only while visible: no background load on the free public API
      timer = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    },
    onHide() { clearInterval(timer); },
  };
}
