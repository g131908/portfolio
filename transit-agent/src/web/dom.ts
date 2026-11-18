// Tiny DOM helpers. All dynamic text goes through esc() before it reaches innerHTML.

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function ago(date: Date, now = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** Readable message for any error a use case can throw. */
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'NotFoundError' || err.name === 'InvalidRequestError') return err.message;
    if (err.name === 'DependencyUnavailableError') return `${err.message}. Please try again in a moment.`;
    if (err.name === 'ModelError') return err.message;
    return `Unexpected error: ${err.message}`;
  }
  return 'Unexpected error';
}

const PRODUCT_LABEL: Record<string, string> = {
  suburban: 'S', subway: 'U', tram: 'Tram', bus: 'Bus', ferry: 'Ferry', regional: 'RE', express: 'ICE', walk: 'Walk', other: '',
};

export function lineBadge(line: string | null, product: string, color: string | null): string {
  const label = line ?? PRODUCT_LABEL[product] ?? product;
  const style = color ? ` style="--line:${esc(color)}"` : '';
  return `<span class="badge p-${esc(product)}"${style} title="${esc(PRODUCT_LABEL[product] ?? product)}">${esc(label)}</span>`;
}

/** Remembers the last value of a form field for this viewer (best effort). */
export const prefs = {
  get(key: string, fallback: string): string {
    try { return localStorage.getItem(`transit:${key}`) ?? fallback; } catch { return fallback; }
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(`transit:${key}`, value); } catch { /* storage unavailable */ }
  },
};
