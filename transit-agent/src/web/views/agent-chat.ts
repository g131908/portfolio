import type { ChatMessage } from '../../agent/chat-model.js';
import { createTools } from '../../agent/tools.js';
import { TransitAgent, type AgentEvent } from '../../agent/transit-agent.js';
import type { Services } from '../../composition.js';
import { OpenAiCompatibleModel } from '../../infrastructure/llm/openai-compatible-model.js';
import { errorText, esc, prefs } from '../dom.js';

const PRESETS = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', needsKey: true },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needsKey: true },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini', needsKey: true },
  ollama: { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', needsKey: false },
  custom: { label: 'Custom', baseUrl: '', model: '', needsKey: false },
} as const;
type PresetId = keyof typeof PRESETS;

const EXAMPLES = [
  'When does the next U8 leave Hermannplatz towards Wittenau?',
  'Ich muss von Leopoldplatz zum Alexanderplatz. Fahrrad oder Bahn?',
  'Are there disruptions at Warschauer Straße right now?',
  'Plan a trip from Zoologischer Garten to Ostkreuz and tell me how crowded it will be.',
];

// The key only lives for this tab (sessionStorage) and is sent nowhere except the chosen API.
const session = {
  get: (k: string) => { try { return sessionStorage.getItem(`transit:${k}`) ?? ''; } catch { return ''; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(`transit:${k}`, v); } catch { /* unavailable */ } },
};

/** Minimal Markdown: paragraphs, bullet lists and **bold**. Input is escaped first. */
function formatAnswer(text: string): string {
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return text.trim().split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-•*] /.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-•*] /, ''))}</li>`).join('')}</ul>`;
    }
    const items = lines.findIndex((l) => /^\s*[-•*] /.test(l));
    if (items > 0 && lines.slice(items).every((l) => /^\s*[-•*] /.test(l))) {
      return `<p>${lines.slice(0, items).map(inline).join('<br>')}</p><ul>${lines.slice(items).map((l) => `<li>${inline(l.replace(/^\s*[-•*] /, ''))}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}

export function mountAgent(root: HTMLElement, services: Services): { onShow(): void; onHide(): void } {
  const tools = createTools(services);
  let history: ChatMessage[] = [];
  let running: AbortController | null = null;
  const preset = (prefs.get('llm-preset', 'openai') in PRESETS ? prefs.get('llm-preset', 'openai') : 'openai') as PresetId;

  root.innerHTML = `
    <div class="agent">
      <details class="card settings" ${session.get('llm-key') || preset === 'ollama' ? '' : 'open'}>
        <summary>Model settings <span class="muted small" id="model-label"></span></summary>
        <form id="llm-form" class="settings-grid">
          <label class="field">Provider
            <select name="preset">${Object.entries(PRESETS).map(([id, p]) => `<option value="${id}" ${id === preset ? 'selected' : ''}>${p.label}</option>`).join('')}</select>
          </label>
          <label class="field">Base URL <input name="baseUrl" spellcheck="false" required></label>
          <label class="field">Model <input name="model" spellcheck="false" required></label>
          <label class="field">API key <input name="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="not needed for local models"></label>
        </form>
        <p class="small muted">Works with any OpenAI-compatible API that supports tool calling, including a local
          <a href="https://ollama.com" rel="noopener">Ollama</a> (start it with <code>OLLAMA_ORIGINS=*</code>).
          Your key stays in this browser tab only and is sent directly to the provider, never to another server.</p>
      </details>

      <div class="chat" id="chat" aria-live="polite">
        <div class="examples">
          <p class="muted">The agent decides which tools to call (departures, trip planning, weather) and answers with live data. Try:</p>
          ${EXAMPLES.map((e) => `<button type="button" class="chip" data-example="${esc(e)}">${esc(e)}</button>`).join('')}
        </div>
      </div>

      <form class="ask" id="ask-form">
        <label class="sr-only" for="question">Your question</label>
        <textarea id="question" name="q" rows="2" maxlength="1000" placeholder="Ask about Berlin public transport…" required></textarea>
        <div class="ask-actions">
          <button class="btn" type="button" id="reset">New chat</button>
          <button class="btn primary" type="submit" id="send">Ask</button>
        </div>
      </form>
    </div>`;

  const form = root.querySelector<HTMLFormElement>('#llm-form')!;
  const chat = root.querySelector<HTMLElement>('#chat')!;
  const ask = root.querySelector<HTMLFormElement>('#ask-form')!;
  const question = root.querySelector<HTMLTextAreaElement>('#question')!;
  const send = root.querySelector<HTMLButtonElement>('#send')!;
  const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement;

  const applyPreset = (id: PresetId, keepSaved: boolean) => {
    const p = PRESETS[id];
    field('baseUrl').value = (keepSaved && prefs.get(`llm-${id}-baseUrl`, '')) || p.baseUrl;
    field('model').value = (keepSaved && prefs.get(`llm-${id}-model`, '')) || p.model;
    (field('apiKey') as HTMLInputElement).required = p.needsKey;
    updateLabel();
  };
  const updateLabel = () => { root.querySelector('#model-label')!.textContent = `· ${field('model').value || 'no model'}`; };

  applyPreset(preset, true);
  field('apiKey').value = session.get('llm-key');
  form.addEventListener('change', (e) => {
    const id = field('preset').value as PresetId;
    if ((e.target as HTMLElement).getAttribute('name') === 'preset') { prefs.set('llm-preset', id); applyPreset(id, true); return; }
    prefs.set(`llm-${id}-baseUrl`, field('baseUrl').value.trim());
    prefs.set(`llm-${id}-model`, field('model').value.trim());
    session.set('llm-key', field('apiKey').value.trim());
    updateLabel();
  });

  const addBubble = (role: 'user' | 'assistant' | 'error', html: string) => {
    chat.querySelector('.examples')?.remove();
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.innerHTML = html;
    chat.append(el);
    el.scrollIntoView({ block: 'end', behavior: 'smooth' });
    return el;
  };

  async function submit(text: string) {
    if (!form.reportValidity()) { (root.querySelector('.settings') as HTMLDetailsElement).open = true; return; }
    const p = PRESETS[field('preset').value as PresetId];
    const apiKey = field('apiKey').value.trim();
    let model: OpenAiCompatibleModel;
    try {
      model = new OpenAiCompatibleModel({
        baseUrl: field('baseUrl').value.trim(), model: field('model').value.trim(),
        ...(apiKey ? { apiKey } : {}), timeoutMs: 60_000,
      });
    } catch (err) {
      addBubble('error', esc(errorText(err)));
      return;
    }
    if (p.needsKey && !apiKey) return;

    addBubble('user', esc(text));
    const bubble = addBubble('assistant', '<div class="trace"><p class="loading">Thinking…</p></div><div class="answer"></div>');
    const trace = bubble.querySelector<HTMLElement>('.trace')!;
    const steps: string[] = [];
    const onEvent = (e: AgentEvent) => {
      if (e.type === 'tool-call') steps.push(`<li data-id="${esc(e.id)}"><code>${esc(e.name)}</code> <span class="muted">${esc(JSON.stringify(e.input))}</span> <span class="st">…</span></li>`);
      if (e.type === 'tool-result') {
        const i = steps.findIndex((s) => s.includes(`data-id="${esc(e.id)}"`));
        if (i >= 0) steps[i] = steps[i]!.replace('<span class="st">…</span>', `<span class="st ${e.ok ? 'ok' : 'bad'}">${e.ok ? '✓' : '✕'} ${e.ms} ms</span>`);
      }
      trace.innerHTML = steps.length
        ? `<details ${e.type === 'answer' ? '' : 'open'}><summary>${steps.length} tool call${steps.length > 1 ? 's' : ''}</summary><ol>${steps.join('')}</ol></details>`
        : '<p class="loading">Thinking…</p>';
    };

    running = new AbortController();
    send.disabled = true;
    send.textContent = 'Working…';
    try {
      const agent = new TransitAgent(model, tools, () => services.clock.now());
      const a = await agent.ask(text, { history, onEvent, signal: running.signal });
      history = [...a.transcript];
      if (!steps.length) trace.remove();
      bubble.querySelector('.answer')!.innerHTML = formatAnswer(a.text)
        + `<p class="meta">${a.toolCalls} tool calls · ${a.steps} steps${a.tokens.prompt ? ` · ${a.tokens.prompt + a.tokens.completion} tokens` : ''}</p>`;
    } catch (err) {
      bubble.remove();
      addBubble('error', esc(errorText(err)));
    } finally {
      running = null;
      send.disabled = false;
      send.textContent = 'Ask';
    }
  }

  ask.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = question.value.trim();
    if (!text || running) return;
    question.value = '';
    void submit(text);
  });
  question.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask.requestSubmit(); }
  });
  chat.addEventListener('click', (e) => {
    const ex = (e.target as HTMLElement).closest<HTMLElement>('[data-example]');
    if (ex) { question.value = ex.dataset['example']!; question.focus(); }
  });
  root.querySelector('#reset')!.addEventListener('click', () => {
    running?.abort();
    history = [];
    chat.innerHTML = '';
    question.focus();
  });

  return { onShow() { question.focus({ preventScroll: true }); }, onHide() {} };
}
