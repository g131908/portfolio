import type { Services, TripPlan } from '../../composition.js';
import { errorText, esc, lineBadge, prefs } from '../dom.js';
import { stopInput, wireSuggestions } from '../stop-input.js';

const MODE_TEXT = { bike: 'Take the bike', transit: 'Take public transport', either: 'Both work' } as const;
const MODE_ICON = { bike: '🚲', transit: '🚇', either: '⚖️' } as const;

function renderPlan(p: TripPlan): string {
  const advice = p.advice
    ? `<article class="card advice mode-${p.advice.mode}">
        <div class="advice-head">
          <span class="advice-icon" aria-hidden="true">${MODE_ICON[p.advice.mode]}</span>
          <div><p class="eyebrow">Recommendation right now</p><h3>${MODE_TEXT[p.advice.mode]}</h3></div>
        </div>
        <div class="compare">
          <div><span class="big">${p.advice.bikeMinutes}</span> min<br><small>by bike (estimate)</small></div>
          <div><span class="big">${p.advice.transitMinutes ?? '–'}</span> min<br><small>fastest connection</small></div>
        </div>
        <ul class="reasons">${p.advice.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        ${p.weatherAvailable ? '' : '<p class="muted small">Weather service unavailable, so the advice ignores the weather.</p>'}
      </article>`
    : '';

  const options = p.options.length
    ? p.options.map((o) => `
      <article class="card option">
        <header class="option-head">
          <strong class="times">${esc(o.departure)} → ${esc(o.arrival)}</strong>
          <span>${o.durationMinutes} min · ${o.transfers === 0 ? 'direct' : `${o.transfers} transfer${o.transfers > 1 ? 's' : ''}`}</span>
        </header>
        <ol class="legs">
          ${o.legs.map((l) => `
            <li>
              ${lineBadge(l.line, l.mode, l.color)}
              <span><strong>${esc(l.departure)}</strong> ${esc(l.from)} → <strong>${esc(l.arrival)}</strong> ${esc(l.to)}
              ${l.direction ? `<small class="muted">towards ${esc(l.direction)}</small>` : ''}
              ${l.delayMinutes ? `<span class="status s-late">+${l.delayMinutes}</span>` : ''}</span>
            </li>`).join('')}
        </ol>
        ${o.warnings.map((w) => `<p class="banner warn small">${esc(w)}</p>`).join('')}
      </article>`).join('')
    : '<p class="empty">No public transport connection found.</p>';

  return `
    <p class="route-title">${esc(p.from.name)} <span aria-hidden="true">→</span> ${esc(p.to.name)}
      ${p.stale ? '<span class="pill warn">cached data</span>' : ''}</p>
    <div class="route-grid">${advice}<div class="options">${options}</div></div>`;
}

export function mountRoute(root: HTMLElement, services: Services): { onShow(): void; onHide(): void } {
  root.innerHTML = `
    <form class="toolbar" id="route-form">
      ${stopInput('From', 'from', prefs.get('route-from', 'Leopoldplatz'))}
      <button class="btn icon" type="button" id="swap" aria-label="Swap start and destination">⇄</button>
      ${stopInput('To', 'to', prefs.get('route-to', 'Alexanderplatz'))}
      <button class="btn primary" type="submit">Plan</button>
    </form>
    <div id="route-out" aria-live="polite"><p class="muted">Compares the fastest connection with a bike ride, using the current weather.</p></div>`;

  const form = root.querySelector<HTMLFormElement>('#route-form')!;
  const out = root.querySelector<HTMLElement>('#route-out')!;
  wireSuggestions(root, services.findStops);

  root.querySelector('#swap')!.addEventListener('click', () => {
    const [a, b] = [form.elements.namedItem('from') as HTMLInputElement, form.elements.namedItem('to') as HTMLInputElement];
    [a.value, b.value] = [b.value, a.value];
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const from = String(new FormData(form).get('from')).trim();
    const to = String(new FormData(form).get('to')).trim();
    out.innerHTML = '<p class="loading">Planning…</p>';
    try {
      const plan = await services.planTrip.execute({ from, to });
      prefs.set('route-from', from);
      prefs.set('route-to', to);
      out.innerHTML = renderPlan(plan);
    } catch (err) {
      out.innerHTML = `<p class="banner error" role="alert">${esc(errorText(err))}</p>`;
    }
  });

  return { onShow() {}, onHide() {} };
}
