// Pure scheduling logic: no DOM, no storage. Covered by test/schedule.test.js.

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

/** "09:30" -> 570 */
export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Invalid time: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid time: ${hhmm}`);
  return h * 60 + min;
}

/** 570 -> "09:30" */
export function fromMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** JS Date -> 1 (Mon) .. 7 (Sun) */
export function isoDay(date) {
  return ((date.getDay() + 6) % 7) + 1;
}

export function overlaps(a, b) {
  return a.day === b.day
    && toMinutes(a.start) < toMinutes(b.end)
    && toMinutes(b.start) < toMinutes(a.end);
}

/** Return pairs of course ids that clash. */
export function findConflicts(courses) {
  const out = [];
  for (let i = 0; i < courses.length; i++) {
    for (let j = i + 1; j < courses.length; j++) {
      if (overlaps(courses[i], courses[j])) out.push([courses[i].id, courses[j].id]);
    }
  }
  return out;
}

export function validateCourse(c) {
  const errors = [];
  if (!c.title || !c.title.trim()) errors.push('Title is required');
  if (!(c.day >= 1 && c.day <= 5)) errors.push('Day must be Monday to Friday');
  try {
    if (toMinutes(c.start) >= toMinutes(c.end)) errors.push('End must be after start');
  } catch {
    errors.push('Times must look like 09:30');
  }
  return errors;
}

/** Courses of a day sorted by start time. */
export function coursesOn(courses, day) {
  return courses.filter((c) => c.day === day).sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
}

/**
 * What matters right now: the running course and the next one (possibly on a later day).
 * @returns {{ current: object|null, next: object|null, nextDayOffset: number }}
 */
export function nowAndNext(courses, date) {
  const day = isoDay(date);
  const minutes = date.getHours() * 60 + date.getMinutes();
  const today = coursesOn(courses, day);
  const current = today.find((c) => toMinutes(c.start) <= minutes && minutes < toMinutes(c.end)) || null;
  let next = today.find((c) => toMinutes(c.start) > minutes) || null;
  let nextDayOffset = 0;
  for (let offset = 1; !next && offset <= 7; offset++) {
    const d = ((day - 1 + offset) % 7) + 1;
    const list = coursesOn(courses, d);
    if (list.length) { next = list[0]; nextDayOffset = offset; }
  }
  return { current, next, nextDayOffset };
}

/**
 * Is a room free at `time` on `day`, and until when?
 * @returns {{ free: boolean, until: string|null, booking: object|null }}
 */
export function roomStatus(roomId, bookings, day, time) {
  const t = toMinutes(time);
  const list = bookings
    .filter((b) => b.room === roomId && b.day === day)
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  const busy = list.find((b) => toMinutes(b.start) <= t && t < toMinutes(b.end));
  if (busy) return { free: false, until: busy.end, booking: busy };
  const upcoming = list.find((b) => toMinutes(b.start) > t);
  return { free: true, until: upcoming ? upcoming.start : null, booking: null };
}

/** Rooms free for at least `minFree` minutes from `time`, best (longest free) first. */
export function freeRooms(rooms, bookings, day, time, { minFree = 45, minSeats = 0, feature = '' } = {}) {
  const t = toMinutes(time);
  const close = toMinutes('20:00');
  return rooms
    .filter((r) => r.seats >= minSeats && (!feature || r.features.includes(feature)))
    .map((r) => ({ room: r, ...roomStatus(r.id, bookings, day, time) }))
    .filter((s) => s.free)
    .map((s) => ({ ...s, freeFor: (s.until ? toMinutes(s.until) : close) - t }))
    .filter((s) => s.freeFor >= minFree)
    .sort((a, b) => b.freeFor - a.freeFor || a.room.id.localeCompare(b.room.id));
}

/** Price by group: 0 student, 1 staff, 2 guest */
export function formatPrice(value) {
  return value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

export function filterMeals(meals, { diet = 'all', exclude = [] } = {}) {
  return meals.filter((m) => {
    if (diet === 'vegan' && !m.tags.includes('vegan')) return false;
    if (diet === 'vegetarian' && !(m.tags.includes('vegan') || m.tags.includes('vegetarian'))) return false;
    return !m.allergens.some((a) => exclude.includes(a));
  });
}

/**
 * Export the timetable as an iCalendar file with weekly recurring events,
 * so it can be imported into Google Calendar, Outlook or Apple Calendar.
 */
export function toICS(courses, semesterStart, semesterEnd) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d, hhmm) => {
    const [h, m] = hhmm.split(':');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(h)}${pad(m)}00`;
  };
  const until = `${semesterEnd.getFullYear()}${pad(semesterEnd.getMonth() + 1)}${pad(semesterEnd.getDate())}T235959Z`;
  const esc = (s) => String(s).replace(/([,;\\])/g, '\\$1');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Campus Companion//EN', 'CALSCALE:GREGORIAN'];
  for (const c of courses) {
    const first = new Date(semesterStart);
    while (isoDay(first) !== c.day) first.setDate(first.getDate() + 1);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${c.id}@campus-companion`,
      `DTSTART;TZID=Europe/Berlin:${stamp(first, c.start)}`,
      `DTEND;TZID=Europe/Berlin:${stamp(first, c.end)}`,
      `RRULE:FREQ=WEEKLY;UNTIL=${until}`,
      `SUMMARY:${esc(c.title)}${c.type ? ` (${esc(c.type)})` : ''}`,
      c.room ? `LOCATION:${esc(c.room)}` : null,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).join('\r\n');
}

/**
 * Assign side-by-side lanes to overlapping courses so clashes stay readable.
 * @returns {Map<string, {lane:number, lanes:number}>}
 */
export function assignLanes(courses) {
  const result = new Map();
  for (let day = 1; day <= 7; day++) {
    const list = coursesOn(courses, day);
    let cluster = [];
    let clusterEnd = -1;
    const flush = () => {
      const laneEnds = [];
      for (const c of cluster) {
        let lane = laneEnds.findIndex((end) => end <= toMinutes(c.start));
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
        laneEnds[lane] = toMinutes(c.end);
        result.set(c.id, { lane, lanes: 0 });
      }
      cluster.forEach((c) => { result.get(c.id).lanes = laneEnds.length; });
      cluster = [];
    };
    for (const c of list) {
      if (cluster.length && toMinutes(c.start) >= clusterEnd) flush();
      cluster.push(c);
      clusterEnd = Math.max(clusterEnd, toMinutes(c.end));
    }
    if (cluster.length) flush();
  }
  return result;
}
