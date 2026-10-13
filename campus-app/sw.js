// Offline support: cache the app shell, network-first for data so menus stay fresh.
const VERSION = 'campus-v1';
const SHELL = [
  './', 'index.html', 'src/styles.css', 'src/app.js', 'src/store.js', 'src/ui.js', 'src/schedule.js',
  'src/views/home.js', 'src/views/timetable.js', 'src/views/mensa.js', 'src/views/rooms.js',
  'data/courses.json', 'data/mensa.json', 'data/rooms.json', 'icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const isData = new URL(e.request.url).pathname.includes('/data/');
  e.respondWith(isData
    ? fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
    : caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
