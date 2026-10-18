// trip.html destination search: ARIA 1.2 combobox over zh / en names and ISO codes.
import { h, mofaChip, cdcChip } from './trip-dom.js';
import { t, nameOf, altNameOf } from './trip-i18n.js';
import { normKey } from './trip-data.js';

const MAX = 8;

export function createSearch({ input, listEl, statusEl, onOpen }) {
  let model = null;
  let results = [];
  let active = -1;

  function find(raw) {
    const q = normKey(raw);
    if (!q || !model) return [];
    const out = [];
    for (const d of model.dests.values()) {
      let score = Infinity;
      if (d.iso.toLowerCase() === q) score = 0;
      for (const k of d.keys) {
        if (k === q) score = Math.min(score, 0);
        else if (k.startsWith(q)) score = Math.min(score, 1);
        else if (k.includes(q)) score = Math.min(score, 2);
      }
      if (score < Infinity) out.push([score + (d.listed ? 0 : 0.5), d]);
    }
    out.sort((a, b) => a[0] - b[0] || nameOf(a[1]).length - nameOf(b[1]).length);
    return out.slice(0, MAX).map((x) => x[1]);
  }

  function close() {
    listEl.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function setActive(i) {
    active = i;
    listEl.querySelectorAll('[role="option"]').forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    if (i >= 0) {
      const li = listEl.children[i];
      input.setAttribute('aria-activedescendant', li.id);
      li.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  function update() {
    const q = input.value.trim();
    results = find(q);
    active = -1;
    if (!q) { close(); statusEl.textContent = ''; return; }
    if (!results.length) {
      listEl.replaceChildren(h('li', { class: 'opt-empty', role: 'presentation', text: t('search_empty') }));
    } else {
      listEl.replaceChildren(...results.map((d, i) => h('li', {
        id: `opt-${d.iso}`, role: 'option', 'aria-selected': 'false', class: 'opt', dataset: { i: String(i) },
      },
      h('span', { class: 'opt-names' }, h('span', { class: 'opt-name', text: nameOf(d) }), h('span', { class: 'opt-alt', text: `${altNameOf(d)} · ${d.iso}` })),
      h('span', { class: 'opt-chips' },
        d.w ? mofaChip(d.mofa, { size: 'xs', text: d.mofa == null ? t('mofa_regional_only') : undefined }) : mofaChip(null, { size: 'xs' }),
        cdcChip(d.cdc, { size: 'xs' })))));
    }
    listEl.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    statusEl.textContent = results.length ? t('search_count', { n: results.length }) : t('search_empty');
  }

  function choose(i) {
    const d = results[i];
    if (!d) return;
    input.value = nameOf(d);
    close();
    onOpen(d.iso);
  }

  input.addEventListener('input', update);
  input.addEventListener('focus', () => { if (input.value.trim()) update(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (listEl.hidden) update();
      if (results.length) setActive((active + 1) % results.length);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (results.length) setActive(active <= 0 ? results.length - 1 : active - 1);
    } else if (ev.key === 'Enter') {
      if (!input.value.trim()) return;
      ev.preventDefault();
      if (!results.length) update();
      choose(active >= 0 ? active : 0);
    } else if (ev.key === 'Escape') {
      if (!listEl.hidden) { ev.preventDefault(); close(); } else input.value = '';
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  // pointerdown keeps focus in the input; click picks
  listEl.addEventListener('pointerdown', (ev) => { if (ev.target.closest('[role="option"]')) ev.preventDefault(); });
  listEl.addEventListener('click', (ev) => {
    const li = ev.target.closest('[role="option"]');
    if (li) choose(+li.dataset.i);
  });

  return {
    setModel(m) { model = m; },
    refresh() { if (!listEl.hidden) update(); },
  };
}
