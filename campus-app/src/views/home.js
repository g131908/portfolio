import { nowAndNext, coursesOn, isoDay, toMinutes, DAY_NAMES, freeRooms, filterMeals, formatPrice } from '../schedule.js';
import { loadData } from '../store.js';
import { esc, duration } from '../ui.js';

function greeting(date) {
  const h = date.getHours();
  if (h < 11) return 'Good morning';
  if (h < 17) return 'Hello';
  return 'Good evening';
}

function courseCard(c, label, extra = '') {
  return `
    <article class="card course c${c.color ?? 0}">
      <p class="eyebrow">${label}</p>
      <h3>${esc(c.title)}</h3>
      <p class="meta">${esc(c.type || '')} · ${c.start}–${c.end} · <a href="#/rooms?room=${esc(c.room)}">${esc(c.room || 'no room')}</a></p>
      ${extra}
    </article>`;
}

export async function render(main, ctx) {
  const now = ctx.now();
  const day = isoDay(now);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const { current, next, nextDayOffset } = nowAndNext(ctx.courses, now);
  const [rooms, mensa] = await Promise.all([loadData('rooms'), loadData('mensa')]);

  let focus = '';
  if (current) {
    const left = toMinutes(current.end) - minutes;
    const progress = Math.round(((minutes - toMinutes(current.start)) / (toMinutes(current.end) - toMinutes(current.start))) * 100);
    focus += courseCard(current, 'Now', `
      <div class="progress" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><span style="width:${progress}%"></span></div>
      <p class="meta">${duration(left)} left</p>`);
  }
  if (next) {
    const when = nextDayOffset === 0
      ? `Next · in ${duration(toMinutes(next.start) - minutes)}`
      : `Next · ${nextDayOffset === 1 ? 'tomorrow' : DAY_NAMES[next.day - 1]}`;
    focus += courseCard(next, when);
  }
  if (!focus) {
    focus = `<article class="card empty"><h3>No courses yet</h3><p>Add your courses in the <a href="#/timetable">timetable</a>.</p></article>`;
  }

  const todayList = coursesOn(ctx.courses, day);
  const weekday = day <= 5;
  const meals = weekday ? filterMeals(mensa.days[day] || [], { diet: ctx.prefs.diet }) : [];
  const studyDay = weekday ? day : 1;
  const studyTime = weekday && minutes < toMinutes('19:15') ? `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` : '10:00';
  const spots = freeRooms(rooms.rooms, rooms.bookings, studyDay, studyTime, { minFree: 60 }).slice(0, 3);

  main.innerHTML = `
    <header class="page-head">
      <p class="eyebrow">${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <h1>${greeting(now)}${ctx.prefs.name ? `, ${esc(ctx.prefs.name)}` : ''}</h1>
    </header>

    <section class="stack" aria-label="Current and next course">${focus}</section>

    <section aria-labelledby="h-today">
      <div class="section-head"><h2 id="h-today">Today</h2><a href="#/timetable">Full week →</a></div>
      ${todayList.length ? `<ol class="timeline">${todayList.map((c) => `
        <li class="${toMinutes(c.end) <= minutes ? 'past' : ''}">
          <time>${c.start}</time><span class="dot c${c.color ?? 0}"></span>
          <span><strong>${esc(c.title)}</strong><br><small>${esc(c.room)} · until ${c.end}</small></span>
        </li>`).join('')}</ol>` : '<p class="muted">Nothing scheduled today.</p>'}
    </section>

    <div class="grid-2">
      <section aria-labelledby="h-mensa">
        <div class="section-head"><h2 id="h-mensa">Mensa</h2><a href="#/mensa">Menu →</a></div>
        ${meals.length ? `<ul class="list">${meals.slice(0, 2).map((m) => `
          <li><span>${esc(m.name)}</span><strong>${formatPrice(m.prices[ctx.prefs.priceGroup])}</strong></li>`).join('')}</ul>`
          : '<p class="muted">Closed today.</p>'}
      </section>
      <section aria-labelledby="h-study">
        <div class="section-head"><h2 id="h-study">Free to study${weekday ? ' now' : ' Mon 10:00'}</h2><a href="#/rooms">Find room →</a></div>
        <ul class="list">${spots.map((s) => `
          <li><a href="#/rooms?room=${s.room.id}">${s.room.id}</a><span class="muted">${s.room.type} · ${s.room.seats} seats</span><strong>${s.until ? `until ${s.until}` : 'all day'}</strong></li>`).join('')}</ul>
      </section>
    </div>`;
}
