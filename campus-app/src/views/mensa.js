import { DAYS, DAY_NAMES, isoDay, filterMeals, formatPrice } from '../schedule.js';
import { loadData } from '../store.js';
import { esc } from '../ui.js';

const ALLERGENS = ['gluten', 'milk', 'egg', 'fish', 'soy', 'sesame', 'mustard', 'celery'];
const GROUPS = ['Students', 'Staff', 'Guests'];
const CO2_LABEL = { A: 'very low', B: 'low', C: 'medium', D: 'high' };

export async function render(main, ctx) {
  const data = await loadData('mensa');
  const today = isoDay(ctx.now());
  const day = ctx.state.mensaDay || (today <= 5 ? today : 1);
  const { prefs } = ctx;
  const meals = filterMeals(data.days[day] || [], { diet: prefs.diet, exclude: prefs.exclude });
  const hidden = (data.days[day] || []).length - meals.length;

  main.innerHTML = `
    <header class="page-head">
      <p class="eyebrow">Mensa · 11:00–14:30</p>
      <h1>${DAY_NAMES[day - 1]}'s menu</h1>
    </header>

    <div class="day-tabs" role="tablist" aria-label="Day">
      ${DAYS.map((d, i) => `<button role="tab" type="button" data-day="${i + 1}" aria-selected="${i + 1 === day}" class="${i + 1 === today ? 'today' : ''}">${d}</button>`).join('')}
    </div>

    <details class="filters" ${prefs.exclude.length || prefs.diet !== 'all' ? 'open' : ''}>
      <summary>Filters &amp; price group</summary>
      <div class="filter-row" role="radiogroup" aria-label="Diet">
        ${['all', 'vegetarian', 'vegan'].map((d) => `
          <label class="chip"><input type="radio" name="diet" value="${d}" ${prefs.diet === d ? 'checked' : ''}><span>${d === 'all' ? 'Everything' : d[0].toUpperCase() + d.slice(1)}</span></label>`).join('')}
      </div>
      <p class="label">Hide dishes containing</p>
      <div class="filter-row">
        ${ALLERGENS.map((a) => `
          <label class="chip"><input type="checkbox" name="allergen" value="${a}" ${prefs.exclude.includes(a) ? 'checked' : ''}><span>${a}</span></label>`).join('')}
      </div>
      <p class="label">Prices for</p>
      <div class="filter-row">
        ${GROUPS.map((g, i) => `<label class="chip"><input type="radio" name="group" value="${i}" ${prefs.priceGroup === i ? 'checked' : ''}><span>${g}</span></label>`).join('')}
      </div>
    </details>

    <ul class="meals">
      ${meals.map((m) => `
        <li class="card meal">
          <div>
            <h3>${esc(m.name)}</h3>
            <p class="tags">
              ${m.tags.map((t) => `<span class="tag ${t}">${t}</span>`).join('')}
              <span class="tag co2 co2-${m.co2}" title="CO₂ footprint: ${CO2_LABEL[m.co2]}">CO₂ ${m.co2}</span>
            </p>
            ${m.allergens.length ? `<p class="meta">Contains: ${m.allergens.join(', ')}</p>` : ''}
          </div>
          <strong class="price">${formatPrice(m.prices[prefs.priceGroup])}</strong>
        </li>`).join('') || '<li class="muted">No dishes match your filters.</li>'}
    </ul>
    ${hidden > 0 ? `<p class="muted small">${hidden} dish${hidden > 1 ? 'es' : ''} hidden by your filters.</p>` : ''}
    <p class="muted small">Sample data for the prototype.</p>`;

  main.querySelectorAll('[data-day]').forEach((el) => el.addEventListener('click', () => {
    ctx.state.mensaDay = Number(el.dataset.day);
    render(main, ctx);
  }));
  main.querySelector('.filters').addEventListener('change', () => {
    const f = main.querySelector('.filters');
    ctx.setPrefs({
      diet: f.querySelector('input[name=diet]:checked').value,
      exclude: [...f.querySelectorAll('input[name=allergen]:checked')].map((i) => i.value),
      priceGroup: Number(f.querySelector('input[name=group]:checked').value),
    });
    render(main, ctx);
  });
}
