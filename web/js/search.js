// Search combobox: countries (zh / en / ISO) plus airports and cities (zh / en / IATA code, js/places.js, loaded on
// first use), each opening its country; map layer switch (the level filter lives in the legend, js/hud.js).
import {
  state, levelOf, alertsOf, warnLevel, mofaMode,
} from './state.js';
import {
  t, countryName, badge, fmtNum, wbadge,
} from './i18n.js';
import { esc, $ } from './util.js';
import {
  loadPlaces, findPlaces, placeName, COUNTRY_ALIASES, popRank, placeRank,
} from './places.js';

/** Lower case, full-width → half-width, accents dropped ("Türkiye" answers to "tur", "Côte" to "cote"). */
export const fold = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFKC').toLowerCase().trim();

function index() {
  const map = new Map();
  const add = (iso, ...names) => {
    if (!/^[A-Z]{2}$/.test(iso)) return;
    if (!map.has(iso)) map.set(iso, new Set());
    names.filter(Boolean).forEach((n) => map.get(iso).add(fold(n)));
  };
  for (const [iso, c] of Object.entries(state.data.countries || {})) add(iso, c.zh, c.en, iso);
  for (const [iso, c] of Object.entries(state.data.alerts?.countries || {})) add(iso, c.name_zh, c.name_en, iso);
  for (const [iso, c] of Object.entries(state.data.warnings?.countries || {})) add(iso, c.name_zh, c.name_en);
  for (const [iso, n] of state.data.worldNames) add(iso, n, iso);
  for (const [iso, names] of Object.entries(COUNTRY_ALIASES)) if (map.has(iso)) add(iso, ...names);
  return map;
}

export function createSearch({ root, onPick }) {
  const input = $('input', root);
  const list = $('[role="listbox"]', root);
  let idx = null;
  let results = [];
  let active = -1;

  function search(q) {
    idx = idx || index();
    const s = fold(q);
    if (!s) return [];
    const scored = [];
    for (const [iso, names] of idx) {
      let best = Infinity;
      for (const n of names) {
        if (n === s) best = Math.min(best, 0);
        else if (n.startsWith(s)) best = Math.min(best, 1);
        else if (n.includes(s)) best = Math.min(best, 2);
      }
      if (best < Infinity) scored.push({ iso, score: best, lvl: mofaMode() ? warnLevel(iso) : levelOf(iso) });
    }
    scored.sort((a, b) => a.score - b.score || popRank(a.iso) - popRank(b.iso) || b.lvl - a.lvl || countryName(a.iso).localeCompare(countryName(b.iso)));
    const countries = scored.slice(0, 8);
    // airports / cities: after the countries of the same quality (places.js placeRank)
    const places = findPlaces(q, 6).map(({ place, score }) => ({
      iso: place.iso, place, score: placeRank(place, score, q), lvl: mofaMode() ? warnLevel(place.iso) : levelOf(place.iso),
    }));
    return [...countries, ...places].sort((a, b) => a.score - b.score).slice(0, 10);
  }

  function renderList() {
    if (!input.value.trim()) { close(); return; }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (!results.length) {
      list.innerHTML = `<li class="opt-empty" role="presentation">${esc(t('search_empty'))}</li>`;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    const en = state.lang === 'en';
    list.innerHTML = results.map((r, i) => {
      const lvlBadge = mofaMode() ? wbadge(r.lvl, r.lvl ? `L${r.lvl}` : '—', 'badge-sm') : badge(r.lvl, r.lvl ? `L${r.lvl}` : '—', 'badge-sm');
      const attrs = `role="option" id="opt-${i}" data-iso="${r.iso}" aria-selected="${i === active}" class="${i === active ? 'active' : ''}${r.place ? ' opt-place' : ''}"`;
      if (r.place) {
        const p = r.place;
        const other = en ? p.zh : (p.zh && p.en);
        return `
      <li ${attrs}>
        ${lvlBadge}
        <span class="opt-name"><span class="opt-kind" aria-hidden="true">${p.kind === 'airport' ? '✈' : '●'}</span>${esc(placeName(p, en))}</span>
        <span class="opt-alt">${esc(other ? `${other} · ` : '')}${esc(countryName(p.iso))}</span>
        <span class="opt-meta mono">${esc(p.code || t('search_city'))}</span>
      </li>`;
      }
      const n = alertsOf(r.iso).length;
      return `
      <li ${attrs}>
        ${lvlBadge}
        <span class="opt-name">${esc(countryName(r.iso))}</span>
        <span class="opt-alt">${esc(countryName(r.iso, en ? 'zh-Hant' : 'en'))}</span>
        <span class="opt-meta mono">${r.iso}${n ? ` · ${fmtNum(n)}` : ''}</span>
      </li>`;
    }).join('');
    if (active >= 0) input.setAttribute('aria-activedescendant', `opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function close() {
    list.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function choose(iso) {
    close();
    input.value = '';
    input.blur();
    onPick(iso);
  }

  function update() {
    results = search(input.value);
    active = results.length ? 0 : -1;
    renderList();
  }
  // the place index loads on first use; re-run the query when it arrives
  const warm = () => loadPlaces().then(() => { if (input.value.trim()) update(); }).catch(() => {});
  input.addEventListener('focus', warm, { once: true });
  input.addEventListener('input', () => { warm(); update(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      renderList();
    } else if (e.key === 'Enter') {
      if (active >= 0 && results[active]) { e.preventDefault(); choose(results[active].iso); }
    } else if (e.key === 'Escape') {
      if (!list.hidden) { e.stopPropagation(); close(); }
      else input.value = '';
    }
  });
  input.addEventListener('focus', () => { if (input.value.trim()) renderList(); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('[data-iso]');
    if (li) { e.preventDefault(); choose(li.dataset.iso); }
  });

  return {
    refresh: () => { idx = null; if (!list.hidden) { results = search(input.value); renderList(); } },
    isOpen: () => !list.hidden,
    close,
  };
}

/** Segmented switch between the CDC health layer and the MOFA/MAC travel-warning layer. */
export function renderLayerSwitch(node, onChange) {
  const ok = !!state.data.warnings;
  const btn = (id, sub, title, disabled = false) => `
    <button type="button" class="seg-btn seg-${id}" data-layer="${id}" aria-pressed="${state.layer === id && (id === 'cdc' || ok)}"
      title="${esc(disabled ? t('layer_unavailable') : t(title))}"${disabled ? ' disabled' : ''}>
      <span class="seg-main">${esc(t(`layer_${id}`))}</span><span class="seg-sub mono">${esc(t(sub))}</span>
    </button>`;
  node.setAttribute('aria-label', t('layer_label'));
  node.innerHTML = btn('cdc', 'layer_cdc_sub', 'layer_cdc_title') + btn('mofa', 'layer_mofa_sub', 'layer_mofa_title', !ok);
  node.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.layer === state.layer) return;
    onChange(b.dataset.layer);
  }));
}
