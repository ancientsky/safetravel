// Country search combobox (zh / en / ISO), map layer switch and level filter chips.
import {
  state, levelOf, alertsOf, warnLevel, mofaMode,
} from './state.js';
import {
  t, countryName, badge, levelShort, fmtNum, wLevelShort, wbadge,
} from './i18n.js';
import { esc, $ } from './util.js';

function index() {
  const map = new Map();
  const add = (iso, ...names) => {
    if (!/^[A-Z]{2}$/.test(iso)) return;
    if (!map.has(iso)) map.set(iso, new Set());
    names.filter(Boolean).forEach((n) => map.get(iso).add(String(n).toLowerCase().normalize('NFKC')));
  };
  for (const [iso, c] of Object.entries(state.data.countries || {})) add(iso, c.zh, c.en, iso);
  for (const [iso, c] of Object.entries(state.data.alerts?.countries || {})) add(iso, c.name_zh, c.name_en, iso);
  for (const [iso, c] of Object.entries(state.data.warnings?.countries || {})) add(iso, c.name_zh, c.name_en);
  for (const [iso, n] of state.data.worldNames) add(iso, n, iso);
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
    const s = q.trim().toLowerCase().normalize('NFKC');
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
    scored.sort((a, b) => a.score - b.score || b.lvl - a.lvl || countryName(a.iso).localeCompare(countryName(b.iso)));
    return scored.slice(0, 8);
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
    list.innerHTML = results.map((r, i) => {
      const n = alertsOf(r.iso).length;
      return `
      <li role="option" id="opt-${r.iso}" data-iso="${r.iso}" aria-selected="${i === active}" class="${i === active ? 'active' : ''}">
        ${mofaMode() ? wbadge(r.lvl, r.lvl ? `L${r.lvl}` : '—', 'badge-sm') : badge(r.lvl, r.lvl ? `L${r.lvl}` : '—', 'badge-sm')}
        <span class="opt-name">${esc(countryName(r.iso))}</span>
        <span class="opt-alt">${esc(countryName(r.iso, state.lang === 'en' ? 'zh-Hant' : 'en'))}</span>
        <span class="opt-meta mono">${r.iso}${n ? ` · ${fmtNum(n)}` : ''}</span>
      </li>`;
    }).join('');
    if (active >= 0) input.setAttribute('aria-activedescendant', `opt-${results[active].iso}`);
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

  input.addEventListener('input', () => {
    results = search(input.value);
    active = results.length ? 0 : -1;
    renderList();
  });
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

function renderWarnChips(node, onChange) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const iso of Object.keys(state.data.warnings?.countries || {})) {
    const l = warnLevel(iso);
    if (l) counts[l]++;
  }
  node.setAttribute('aria-label', t('filter_label'));
  node.innerHTML = `<span class="chips-label">${esc(t('filter_label'))}</span>` + [4, 3, 2, 1].map((l) => `
    <button type="button" class="chip-filter wl-${l}" data-level="${l}" aria-pressed="${state.wfilter.has(l)}" title="${esc(wLevelShort(l))}">
      <i class="dot wl-${l}" aria-hidden="true"></i>${esc(t(`wl_chip_${l}`))}<b class="mono">${fmtNum(counts[l])}</b>
    </button>`).join('') + `
    <button type="button" class="chip-filter chip-all" data-level="all" aria-pressed="${state.wfilter.size === 0}">${esc(t('filter_all'))}</button>`;
  node.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.level;
    if (v === 'all') state.wfilter.clear();
    else {
      const l = +v;
      if (state.wfilter.has(l)) state.wfilter.delete(l);
      else state.wfilter.add(l);
      if (state.wfilter.size === 4) state.wfilter.clear();
    }
    onChange();
  }));
}

export function renderFilterChips(node, onChange) {
  if (mofaMode()) { renderWarnChips(node, onChange); return; }
  const c = state.data.alerts?.countries || {};
  const counts = { 1: 0, 2: 0, 3: 0 };
  for (const v of Object.values(c)) if (v.max_level) counts[v.max_level]++;
  node.setAttribute('aria-label', t('filter_label'));
  node.innerHTML = `<span class="chips-label">${esc(t('filter_label'))}</span>` + [3, 2, 1].map((l) => `
    <button type="button" class="chip-filter lvl-${l}" data-level="${l}" aria-pressed="${state.filter.has(l)}" title="${esc(levelShort(l))}">
      <i class="dot lvl-${l}" aria-hidden="true"></i>${esc(t(`level_chip_${l}`))}<b class="mono">${fmtNum(counts[l])}</b>
    </button>`).join('') + `
    <button type="button" class="chip-filter chip-all" data-level="all" aria-pressed="${state.filter.size === 0}">${esc(t('filter_all'))}</button>`;
  node.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.level;
    if (v === 'all') state.filter.clear();
    else {
      const l = +v;
      if (state.filter.has(l)) state.filter.delete(l);
      else state.filter.add(l);
      if (state.filter.size === 3) state.filter.clear();
    }
    onChange();
  }));
}
