// Hash router + shared app context. No framework, no build step.
import { read, write, loadData } from './store.js';
import { esc } from './ui.js';
import * as home from './views/home.js';
import * as timetable from './views/timetable.js';
import * as mensa from './views/mensa.js';
import * as rooms from './views/rooms.js';

const routes = { '': home, timetable, mensa, rooms };
const main = document.getElementById('main');

const ctx = {
  courses: [],
  prefs: read('prefs', { diet: 'all', exclude: [], priceGroup: 0, name: '' }),
  state: {},              // per-session UI state (selected day, filters)
  params: new URLSearchParams(),
  // ?now=2026-10-12T09:30 lets you demo the app at any time of the week
  now: () => {
    const fake = new URLSearchParams(location.search).get('now');
    const d = fake ? new Date(fake) : new Date();
    return Number.isNaN(d.getTime()) ? new Date() : d;
  },
  setCourses(list) {
    ctx.courses = list;
    write('courses', list);
    route();
  },
  setPrefs(patch) {
    Object.assign(ctx.prefs, patch);
    write('prefs', ctx.prefs);
  },
};

async function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const view = routes[path] || home;
  ctx.params = new URLSearchParams(query);
  document.querySelectorAll('.nav a').forEach((a) => {
    const active = a.dataset.route === (path || 'home');
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  try {
    await view.render(main, ctx);
  } catch (err) {
    main.innerHTML = `<p class="alert">Something went wrong: ${esc(err.message)}</p>`;
    console.error(err);
  }
  document.title = `${main.querySelector('h1')?.textContent || 'Campus'} · Campus Companion`;
}

function initTheme() {
  const saved = read('theme', null);
  if (saved) document.documentElement.dataset.theme = saved;
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    write('theme', next);
  });
}

async function boot() {
  initTheme();
  ctx.courses = read('courses', null) || await loadData('courses');
  window.addEventListener('hashchange', () => { route(); main.focus({ preventScroll: true }); window.scrollTo(0, 0); });
  route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
