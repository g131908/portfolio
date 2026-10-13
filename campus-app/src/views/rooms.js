import { DAY_NAMES, isoDay, freeRooms, roomStatus, toMinutes } from '../schedule.js';
import { loadData } from '../store.js';
import { esc, duration } from '../ui.js';

const FEATURES = { '': 'Any', pcs: 'PCs', macs: 'Macs', projector: 'Projector', screen: 'Screen', whiteboard: 'Whiteboard', audio: 'Audio' };

function defaultSlot(now) {
  const day = isoDay(now);
  const m = now.getHours() * 60 + now.getMinutes();
  // weekend or evening -> next weekday morning; early morning -> same day 10:00
  if (day > 5 || m > toMinutes('19:00')) return { day: day >= 5 ? 1 : day + 1, time: '10:00' };
  if (m < toMinutes('07:30')) return { day, time: '10:00' };
  const rounded = Math.ceil(m / 15) * 15;
  return { day, time: `${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}` };
}

function campusMap(data, highlight, freeIds) {
  return `
    <svg class="map" viewBox="0 0 320 270" role="img" aria-label="Campus map">
      <rect x="10" y="10" width="300" height="250" rx="14" class="map-ground"/>
      <path d="M170 20 V250 M20 125 H300" class="map-path"/>
      ${data.buildings.map((b) => {
        const free = data.rooms.filter((r) => r.building === b.id && freeIds.has(r.id)).length;
        const active = highlight && highlight.building === b.id;
        return `
        <g class="bld ${active ? 'active' : ''}">
          <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6"/>
          <text x="${b.x + 10}" y="${b.y + 22}" class="bld-id">${b.id}</text>
          <text x="${b.x + 10}" y="${b.y + 38}" class="bld-label">${b.label}</text>
          <text x="${b.x + 10}" y="${b.y + b.h - 10}" class="bld-free">${free} free</text>
        </g>`;
      }).join('')}
    </svg>`;
}

export async function render(main, ctx) {
  const data = await loadData('rooms');
  const slot = ctx.state.slot || defaultSlot(ctx.now());
  const filter = ctx.state.roomFilter || { feature: '', minSeats: 0, minFree: 45, query: '' };
  const selected = data.rooms.find((r) => r.id === ctx.params.get('room')) || null;

  const free = freeRooms(data.rooms, data.bookings, slot.day, slot.time, filter)
    .filter((s) => !filter.query || s.room.id.toLowerCase().includes(filter.query.toLowerCase()) || s.room.type.toLowerCase().includes(filter.query.toLowerCase()));
  const freeIds = new Set(free.map((s) => s.room.id));

  let detail = '';
  if (selected) {
    const st = roomStatus(selected.id, data.bookings, slot.day, slot.time);
    const bookings = data.bookings.filter((b) => b.room === selected.id && b.day === slot.day);
    detail = `
      <article class="card room-detail" aria-live="polite">
        <div class="row">
          <div><p class="eyebrow">Building ${selected.building} · floor ${selected.floor}</p><h2>${selected.id}</h2></div>
          <span class="status ${st.free ? 'free' : 'busy'}">${st.free ? 'Free' : 'In use'}</span>
        </div>
        <p class="meta">${selected.type} · ${selected.seats} seats${selected.features.length ? ` · ${selected.features.join(', ')}` : ''}</p>
        <p>${st.free ? (st.until ? `Free until ${st.until}` : 'Free for the rest of the day') : `${esc(st.booking.title)} until ${st.until}`}</p>
        <p class="label">${DAY_NAMES[slot.day - 1]}</p>
        <ul class="list">${bookings.map((b) => `<li><span>${b.start}–${b.end}</span><span>${esc(b.title)}</span></li>`).join('') || '<li class="muted">No bookings.</li>'}</ul>
        <a href="#/rooms" class="btn">Close</a>
      </article>`;
  }

  main.innerHTML = `
    <header class="page-head">
      <p class="eyebrow">Find a free room</p>
      <h1>Rooms</h1>
    </header>

    <form class="room-form" id="room-form">
      <label>Day
        <select name="day">${DAY_NAMES.map((d, i) => `<option value="${i + 1}" ${slot.day === i + 1 ? 'selected' : ''}>${d}</option>`).join('')}</select>
      </label>
      <label>From <input type="time" name="time" value="${slot.time}" step="900" min="07:00" max="19:30"></label>
      <label>For at least
        <select name="minFree">${[30, 45, 90, 180].map((m) => `<option value="${m}" ${filter.minFree === m ? 'selected' : ''}>${duration(m)}</option>`).join('')}</select>
      </label>
      <label>Seats
        <select name="minSeats">${[0, 6, 12, 30].map((n) => `<option value="${n}" ${filter.minSeats === n ? 'selected' : ''}>${n ? `${n}+` : 'Any'}</option>`).join('')}</select>
      </label>
      <label>Equipment
        <select name="feature">${Object.entries(FEATURES).map(([k, v]) => `<option value="${k}" ${filter.feature === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </label>
      <label class="grow">Search <input type="search" name="query" value="${esc(filter.query)}" placeholder="e.g. B2 or lab"></label>
    </form>

    ${detail}

    <div class="grid-2 rooms-layout">
      <section aria-labelledby="h-free">
        <h2 id="h-free">${free.length} room${free.length === 1 ? '' : 's'} free</h2>
        <ul class="room-list">
          ${free.map((s) => `
            <li><a class="card room ${selected?.id === s.room.id ? 'active' : ''}" href="#/rooms?room=${s.room.id}">
              <span class="room-id">${s.room.id}</span>
              <span><strong>${s.room.type}</strong><br><small>${s.room.seats} seats${s.room.features.length ? ` · ${s.room.features.join(', ')}` : ''}</small></span>
              <span class="free-for">${s.until ? `until ${s.until}` : 'all day'}<br><small>${duration(s.freeFor)}</small></span>
            </a></li>`).join('') || '<li class="muted">No room matches. Try a shorter duration or fewer filters.</li>'}
        </ul>
      </section>
      <section aria-label="Campus map">${campusMap(data, selected, freeIds)}</section>
    </div>`;

  const form = main.querySelector('#room-form');
  form.addEventListener('input', () => {
    ctx.state.slot = { day: Number(form.day.value), time: form.time.value || '10:00' };
    ctx.state.roomFilter = {
      feature: form.feature.value,
      minSeats: Number(form.minSeats.value),
      minFree: Number(form.minFree.value),
      query: form.query.value,
    };
    const focusName = document.activeElement?.name;
    const caret = document.activeElement?.selectionStart;
    render(main, ctx).then(() => {
      const el = main.querySelector(`[name="${focusName}"]`);
      if (el) { el.focus(); if (caret != null && el.setSelectionRange) el.setSelectionRange(caret, caret); }
    });
  });
  form.addEventListener('submit', (e) => e.preventDefault());
}
