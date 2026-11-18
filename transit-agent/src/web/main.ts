// Browser entry point: wires services once and mounts the four views.

import { createServices } from '../composition.js';
import { $ } from './dom.js';
import { mountAgent } from './views/agent-chat.js';
import { mountDepartures } from './views/departures.js';
import { mountRoute } from './views/route.js';
import { healthSummary, mountSystem } from './views/system.js';

const services = createServices();

const views = {
  departures: mountDepartures($('#panel-departures'), services),
  route: mountRoute($('#panel-route'), services),
  agent: mountAgent($('#panel-agent'), services),
  system: mountSystem($('#panel-system'), services),
};
type ViewId = keyof typeof views;

let current: ViewId | null = null;
function show(id: ViewId) {
  if (current === id) return;
  if (current) views[current].onHide();
  for (const key of Object.keys(views) as ViewId[]) {
    $(`#panel-${key}`).hidden = key !== id;
    $(`#tab-${key}`).setAttribute('aria-selected', String(key === id));
    $(`#tab-${key}`).tabIndex = key === id ? 0 : -1;
  }
  current = id;
  views[id].onShow();
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
}

const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => show(tab.id.replace('tab-', '') as ViewId));
  tab.addEventListener('keydown', (e) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    const next = tabs[(i + delta + tabs.length) % tabs.length]!;
    next.focus();
    next.click();
  });
});

const fromHash = location.hash.slice(1);
show(fromHash in views ? (fromHash as ViewId) : 'departures');

// header: Berlin clock + health indicator
const clockFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Berlin' });
const tick = () => {
  $('#clock').textContent = clockFmt.format(services.clock.now());
  const h = healthSummary(services);
  $('#health').dataset['level'] = h.level;
  $('#health-text').textContent = h.text;
};
tick();
setInterval(tick, 1_000);
