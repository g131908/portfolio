import type { Services } from '../../composition.js';
import { esc } from '../dom.js';

export function healthSummary(services: Services): { level: 'ok' | 'degraded' | 'down'; text: string } {
  const { breakers, dependencies } = services.health();
  if (breakers.some((b) => b.state === 'open')) return { level: 'down', text: 'dependency down' };
  if (breakers.some((b) => b.state === 'half-open') || dependencies.some((d) => d.staleServed > 0 && d.lastError)) {
    return { level: 'degraded', text: 'degraded' };
  }
  return { level: 'ok', text: 'all systems normal' };
}

export function mountSystem(root: HTMLElement, services: Services): { onShow(): void; onHide(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;

  const render = () => {
    const { breakers, dependencies } = services.health();
    root.innerHTML = `
      <p class="muted">What the resilience layer is doing in this browser session. Every call to an external API
        goes through a timeout, bounded retries with jittered backoff, a circuit breaker and a cache with
        stale-if-error fallback.</p>
      <div class="cards">
        ${breakers.map((b) => `
          <article class="card breaker b-${b.state}">
            <p class="eyebrow">Circuit breaker</p>
            <h3>${esc(b.name)}</h3>
            <p class="state">${esc(b.state)}</p>
            <p class="small muted">${b.consecutiveFailures} consecutive failures</p>
          </article>`).join('')}
      </div>
      <table class="metrics">
        <thead><tr><th scope="col">Dependency</th><th scope="col" class="num">Requests</th><th scope="col" class="num">Cache hits</th>
          <th scope="col" class="num">Retries</th><th scope="col" class="num">Failures</th><th scope="col" class="num">Stale served</th>
          <th scope="col" class="num">p50</th><th scope="col" class="num">p95</th></tr></thead>
        <tbody>
          ${dependencies.length ? dependencies.map((d) => `
            <tr><td>${esc(d.dependency)}</td><td class="num">${d.requests}</td><td class="num">${d.cacheHits}</td>
              <td class="num">${d.retries}</td><td class="num">${d.failures}</td><td class="num">${d.staleServed}</td>
              <td class="num">${d.p50Ms ?? '–'} ms</td><td class="num">${d.p95Ms ?? '–'} ms</td></tr>
            ${d.lastError ? `<tr class="err-row"><td colspan="8">Last error: ${esc(d.lastError)}</td></tr>` : ''}`).join('')
            : '<tr><td colspan="8" class="muted">No requests yet.</td></tr>'}
        </tbody>
      </table>`;
  };

  return {
    onShow() { render(); clearInterval(timer); timer = setInterval(render, 2_000); },
    onHide() { clearInterval(timer); },
  };
}
