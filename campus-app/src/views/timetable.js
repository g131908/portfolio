import {
  DAYS, DAY_NAMES, toMinutes, findConflicts, validateCourse, coursesOn, isoDay, toICS, assignLanes,
} from '../schedule.js';
import { esc, toast, download, COURSE_COLORS } from '../ui.js';

const START = toMinutes('08:00');
const END = toMinutes('20:00');
const SLOT = 15; // minutes per grid row

function row(time) { return Math.round((toMinutes(time) - START) / SLOT) + 2; }

export function render(main, ctx) {
  const conflicts = findConflicts(ctx.courses);
  const clashing = new Set(conflicts.flat());
  const today = isoDay(ctx.now());
  const selectedDay = ctx.state.day || (today <= 5 ? today : 1);

  const hours = [];
  for (let m = START; m < END; m += 60) {
    hours.push(`<div class="hour" style="grid-row:${(m - START) / SLOT + 2} / span 4">${String(m / 60).padStart(2, '0')}:00</div>`);
  }

  const lanes = assignLanes(ctx.courses);
  const blocks = ctx.courses.map((c) => `
    <button class="block c${c.color ?? 0} ${clashing.has(c.id) ? 'clash' : ''} ${c.day === selectedDay ? 'sel-day' : ''}"
      style="grid-column:${c.day + 1}; grid-row:${row(c.start)} / ${row(c.end)}; --lane:${lanes.get(c.id).lane}; --lanes:${lanes.get(c.id).lanes}"
      data-id="${esc(c.id)}" aria-label="${esc(c.title)}, ${DAY_NAMES[c.day - 1]} ${c.start} to ${c.end}">
      <strong>${esc(c.title)}</strong>
      <span>${c.start}–${c.end}</span>
      <span>${esc(c.room)}</span>
    </button>`).join('');

  main.innerHTML = `
    <header class="page-head row">
      <div>
        <p class="eyebrow">Winter semester</p>
        <h1>Timetable</h1>
      </div>
      <div class="actions">
        <button class="btn" id="tt-ics" type="button">Export .ics</button>
        <button class="btn primary" id="tt-add" type="button">+ Add course</button>
      </div>
    </header>

    ${conflicts.length ? `<p class="alert" role="alert">⚠ ${conflicts.length} time conflict${conflicts.length > 1 ? 's' : ''}: ${conflicts.map(([a, b]) => {
      const t = (id) => esc(ctx.courses.find((c) => c.id === id).title);
      return `${t(a)} ↔ ${t(b)}`;
    }).join(', ')}</p>` : ''}

    <div class="day-tabs mobile-only" role="tablist" aria-label="Day">
      ${DAYS.map((d, i) => `<button role="tab" type="button" data-day="${i + 1}" aria-selected="${i + 1 === selectedDay}" class="${i + 1 === today ? 'today' : ''}">${d}</button>`).join('')}
    </div>

    <div class="week" style="--rows:${(END - START) / SLOT}">
      <div class="corner"></div>
      ${DAYS.map((d, i) => `<div class="day-head ${i + 1 === today ? 'today' : ''} ${i + 1 === selectedDay ? 'sel-day' : ''}" style="grid-column:${i + 2}">${d}</div>`).join('')}
      ${hours.join('')}
      ${DAYS.map((_, i) => `<div class="day-col ${i + 1 === selectedDay ? 'sel-day' : ''}" style="grid-column:${i + 2}"></div>`).join('')}
      ${blocks}
    </div>

    <ul class="day-list" aria-label="${DAY_NAMES[selectedDay - 1]}">
      ${coursesOn(ctx.courses, selectedDay).map((c) => `
        <li><button class="list-course c${c.color ?? 0} ${clashing.has(c.id) ? 'clash' : ''}" data-id="${esc(c.id)}" type="button">
          <time>${c.start}<br>${c.end}</time>
          <span><strong>${esc(c.title)}</strong><br><small>${esc(c.type)} · ${esc(c.room)}</small></span>
        </button></li>`).join('') || '<li class="muted">Free day.</li>'}
    </ul>

    <dialog id="course-dialog" aria-labelledby="dlg-title">
      <form method="dialog" id="course-form" novalidate>
        <h2 id="dlg-title">Course</h2>
        <label>Title <input name="title" required maxlength="60" autocomplete="off"></label>
        <div class="form-row">
          <label>Type
            <select name="type"><option>Lecture</option><option>Lab</option><option>Seminar</option><option>Tutorial</option></select>
          </label>
          <label>Room <input name="room" maxlength="12" autocomplete="off"></label>
        </div>
        <div class="form-row">
          <label>Day
            <select name="day">${DAY_NAMES.map((d, i) => `<option value="${i + 1}">${d}</option>`).join('')}</select>
          </label>
          <label>Start <input name="start" type="time" min="07:00" max="21:00" step="900" required></label>
          <label>End <input name="end" type="time" min="07:00" max="21:00" step="900" required></label>
        </div>
        <fieldset class="swatches"><legend>Colour</legend>
          ${Array.from({ length: COURSE_COLORS }, (_, i) => `<label class="swatch c${i}"><input type="radio" name="color" value="${i}"><span class="sr-only">Colour ${i + 1}</span></label>`).join('')}
        </fieldset>
        <p class="form-error" id="form-error" role="alert"></p>
        <div class="dialog-actions">
          <button class="btn danger" value="delete" id="btn-delete" type="submit">Delete</button>
          <span class="spacer"></span>
          <button class="btn" value="cancel" type="submit" formnovalidate>Cancel</button>
          <button class="btn primary" value="save" type="submit">Save</button>
        </div>
      </form>
    </dialog>`;

  const dialog = main.querySelector('#course-dialog');
  const form = main.querySelector('#course-form');
  let editing = null;

  function open(course) {
    editing = course;
    const c = course || { title: '', type: 'Lecture', room: '', day: selectedDay, start: '10:00', end: '11:30', color: ctx.courses.length % COURSE_COLORS };
    form.title.value = c.title;
    form.type.value = c.type;
    form.room.value = c.room;
    form.day.value = c.day;
    form.start.value = c.start;
    form.end.value = c.end;
    form.querySelector(`input[name=color][value="${c.color ?? 0}"]`).checked = true;
    main.querySelector('#btn-delete').hidden = !course;
    main.querySelector('#dlg-title').textContent = course ? 'Edit course' : 'New course';
    main.querySelector('#form-error').textContent = '';
    dialog.showModal();
    form.title.focus();
  }

  form.addEventListener('submit', (e) => {
    const action = e.submitter?.value;
    if (action === 'cancel') return;
    if (action === 'delete') {
      ctx.setCourses(ctx.courses.filter((c) => c.id !== editing.id));
      toast('Course deleted');
      return;
    }
    const data = {
      id: editing?.id || `c${Date.now().toString(36)}`,
      title: form.title.value.trim(),
      type: form.type.value,
      room: form.room.value.trim().toUpperCase(),
      day: Number(form.day.value),
      start: form.start.value,
      end: form.end.value,
      color: Number(form.querySelector('input[name=color]:checked')?.value ?? 0),
    };
    const errors = validateCourse(data);
    if (errors.length) {
      e.preventDefault();
      main.querySelector('#form-error').textContent = errors.join('. ');
      return;
    }
    const others = ctx.courses.filter((c) => c.id !== data.id);
    ctx.setCourses([...others, data]);
    toast(editing ? 'Course updated' : 'Course added');
  });

  main.querySelector('#tt-add').addEventListener('click', () => open(null));
  main.querySelectorAll('[data-id]').forEach((el) => el.addEventListener('click', () => {
    open(ctx.courses.find((c) => c.id === el.dataset.id));
  }));
  main.querySelectorAll('[data-day]').forEach((el) => el.addEventListener('click', () => {
    ctx.state.day = Number(el.dataset.day);
    render(main, ctx);
  }));
  main.querySelector('#tt-ics').addEventListener('click', () => {
    const now = ctx.now();
    // winter semester ends mid-February, summer semester mid-July
    const m = now.getMonth();
    const end = m >= 2 && m <= 7
      ? new Date(now.getFullYear(), 6, 15)
      : new Date(now.getFullYear() + (m >= 8 ? 1 : 0), 1, 14);
    download('timetable.ics', toICS(ctx.courses, now, end), 'text/calendar');
    toast('Calendar file downloaded');
  });
}
