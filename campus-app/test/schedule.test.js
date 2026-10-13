import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinutes, fromMinutes, isoDay, overlaps, findConflicts, validateCourse,
  nowAndNext, roomStatus, freeRooms, filterMeals, toICS,
} from '../src/schedule.js';

const c = (id, day, start, end) => ({ id, title: id, day, start, end });

test('time conversion round-trips', () => {
  assert.equal(toMinutes('09:30'), 570);
  assert.equal(fromMinutes(570), '09:30');
  assert.throws(() => toMinutes('25:00'));
  assert.throws(() => toMinutes('9.30'));
});

test('isoDay maps Sunday to 7 and Monday to 1', () => {
  assert.equal(isoDay(new Date(2026, 9, 12)), 1); // Mon 12 Oct 2026
  assert.equal(isoDay(new Date(2026, 9, 18)), 7); // Sun
});

test('back-to-back courses do not overlap', () => {
  assert.equal(overlaps(c('a', 1, '08:00', '09:30'), c('b', 1, '09:30', '11:00')), false);
  assert.equal(overlaps(c('a', 1, '08:00', '09:31'), c('b', 1, '09:30', '11:00')), true);
  assert.equal(overlaps(c('a', 1, '08:00', '11:00'), c('b', 2, '08:00', '11:00')), false);
});

test('findConflicts lists clashing pairs', () => {
  const list = [c('a', 1, '08:00', '10:00'), c('b', 1, '09:00', '11:00'), c('d', 2, '09:00', '11:00')];
  assert.deepEqual(findConflicts(list), [['a', 'b']]);
});

test('validateCourse catches bad input', () => {
  assert.deepEqual(validateCourse(c('ok', 1, '08:00', '09:00')), []);
  assert.ok(validateCourse({ title: '', day: 6, start: '10:00', end: '09:00' }).length === 3);
});

test('nowAndNext finds the running and the next course', () => {
  const list = [c('math', 1, '08:00', '10:00'), c('prog', 1, '12:00', '14:00'), c('tcs', 3, '10:00', '12:00')];
  const monday9 = new Date(2026, 9, 12, 9, 0);
  const r = nowAndNext(list, monday9);
  assert.equal(r.current.id, 'math');
  assert.equal(r.next.id, 'prog');
  assert.equal(r.nextDayOffset, 0);
});

test('nowAndNext wraps to a later day (Friday evening -> Monday)', () => {
  const list = [c('math', 1, '08:00', '10:00')];
  const friday = new Date(2026, 9, 16, 18, 0);
  const r = nowAndNext(list, friday);
  assert.equal(r.current, null);
  assert.equal(r.next.id, 'math');
  assert.equal(r.nextDayOffset, 3);
});

const bookings = [
  { room: 'R1', day: 1, start: '10:00', end: '12:00' },
  { room: 'R1', day: 1, start: '14:00', end: '16:00' },
];

test('roomStatus reports busy and free-until', () => {
  assert.deepEqual(roomStatus('R1', bookings, 1, '11:00').free, false);
  assert.equal(roomStatus('R1', bookings, 1, '11:00').until, '12:00');
  assert.equal(roomStatus('R1', bookings, 1, '12:30').until, '14:00');
  assert.equal(roomStatus('R1', bookings, 1, '17:00').until, null);
});

test('freeRooms sorts by longest free time and filters', () => {
  const rooms = [
    { id: 'R1', seats: 30, features: ['pcs'] },
    { id: 'R2', seats: 10, features: [] },
  ];
  const r = freeRooms(rooms, bookings, 1, '12:30');
  assert.deepEqual(r.map((x) => x.room.id), ['R2', 'R1']);
  assert.equal(r[1].freeFor, 90);
  assert.deepEqual(freeRooms(rooms, bookings, 1, '12:30', { feature: 'pcs' }).map((x) => x.room.id), ['R1']);
  assert.deepEqual(freeRooms(rooms, bookings, 1, '13:30', { minFree: 45, minSeats: 20 }), []);
});

test('filterMeals: vegetarian includes vegan, allergens exclude', () => {
  const meals = [
    { name: 'v', tags: ['vegan'], allergens: ['gluten'] },
    { name: 'veg', tags: ['vegetarian'], allergens: ['milk'] },
    { name: 'meat', tags: [], allergens: [] },
  ];
  assert.deepEqual(filterMeals(meals, { diet: 'vegetarian' }).map((m) => m.name), ['v', 'veg']);
  assert.deepEqual(filterMeals(meals, { exclude: ['gluten', 'milk'] }).map((m) => m.name), ['meat']);
});

test('toICS creates weekly events starting on the right weekday', () => {
  const ics = toICS([{ id: 'x', title: 'Math, part 1', type: 'Lecture', day: 3, start: '08:00', end: '09:30', room: 'A001' }],
    new Date(2026, 9, 12), new Date(2027, 1, 12));
  assert.match(ics, /DTSTART;TZID=Europe\/Berlin:20261014T080000/);
  assert.match(ics, /RRULE:FREQ=WEEKLY;UNTIL=20270212T235959Z/);
  assert.match(ics, /SUMMARY:Math\\, part 1 \(Lecture\)/);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR') && ics.endsWith('END:VCALENDAR'));
});

test('assignLanes puts overlapping courses side by side', async () => {
  const { assignLanes } = await import('../src/schedule.js');
  const lanes = assignLanes([c('a', 1, '08:00', '11:00'), c('b', 1, '09:00', '10:00'), c('d', 1, '10:00', '12:00'), c('e', 1, '13:00', '14:00')]);
  assert.deepEqual(lanes.get('a'), { lane: 0, lanes: 2 });
  assert.deepEqual(lanes.get('b'), { lane: 1, lanes: 2 });
  assert.deepEqual(lanes.get('d'), { lane: 1, lanes: 2 });
  assert.deepEqual(lanes.get('e'), { lane: 0, lanes: 1 });
});
