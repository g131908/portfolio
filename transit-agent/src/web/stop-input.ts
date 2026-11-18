// Stop name input with live suggestions (uses the FindStops use case).

import type { FindStops } from '../core/index.js';
import { debounce, esc } from './dom.js';

let counter = 0;

export function stopInput(label: string, name: string, value: string): string {
  const id = `stop-${name}-${++counter}`;
  return `
    <label class="field" for="${id}">${esc(label)}
      <input id="${id}" name="${esc(name)}" value="${esc(value)}" autocomplete="off" list="${id}-list"
        placeholder="e.g. Hermannplatz" required minlength="2" spellcheck="false">
      <datalist id="${id}-list"></datalist>
    </label>`;
}

export function wireSuggestions(root: HTMLElement, findStops: FindStops): void {
  root.querySelectorAll<HTMLInputElement>('input[list]').forEach((input) => {
    const list = root.querySelector<HTMLDataListElement>(`#${CSS.escape(input.getAttribute('list')!)}`)!;
    let lastQuery = '';
    input.addEventListener('input', debounce(async () => {
      const q = input.value.trim();
      if (q.length < 3 || q === lastQuery) return;
      lastQuery = q;
      try {
        const { value } = await findStops.execute({ query: q, limit: 6 });
        if (q !== input.value.trim()) return; // a newer keystroke won
        list.innerHTML = value.map((s) => `<option value="${esc(s.name)}"></option>`).join('');
      } catch { /* suggestions are optional */ }
    }, 250));
  });
}
