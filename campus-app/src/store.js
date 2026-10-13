// Tiny persistent store. localStorage can be unavailable (private mode, blocked
// cookies), so every access is guarded and the app keeps working in memory.

const PREFIX = 'campus:';

export function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch { /* in-memory only */ }
}

const cache = new Map();

/** Fetch a JSON file from /data once per session. */
export async function loadData(name) {
  if (!cache.has(name)) {
    cache.set(name, fetch(`data/${name}.json`).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${name}`);
      return r.json();
    }));
  }
  return cache.get(name);
}
