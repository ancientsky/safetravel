// trip.html "all destinations" table: filters, sortable columns, CSV export (built in the browser).
import { h, mofaChip, cdcChip } from './trip-dom.js';
import {
  t, isEn, getLang, nameOf, altNameOf, regionName, mofaFull, diseaseName, fmtDay,
} from './trip-i18n.js';
import { REGIONS, safeHref, normKey, dayAgo } from './trip-data.js';

const MOFA_BUCKETS = ['4', '3', '2', '1', '0', 'n'];
const CDC_BUCKETS = ['3', '2', '1', '0'];
const DEFAULT_DIR = { name: 1, region: 1, mofa: -1, cdc: -1, date: -1 };

const mofaBucket = (d) => (d.w ? String(d.mofa ?? 0) : 'n');
const mofaRank = (d) => (d.w ? (d.mofa ?? 0) : -1);
const needsCare = (d) => (d.mofaMax ?? -1) >= 3 || d.cdc >= 2;

export function createTable({ root, onOpen, onPrint }) {
  const st = {
    q: '', region: '', mofa: new Set(MOFA_BUCKETS), cdc: new Set(CDC_BUCKETS), attention: false,
    sort: 'mofa', dir: -1,
  };
  let model = null;
  let rows = new Map(); // iso → <tr>
  let shown = [];

  const tbody = root.querySelector('tbody');
  const thead = root.querySelector('thead');
  const countEl = root.querySelector('.t-count');
  const emptyEl = root.querySelector('.t-empty');
  const filtersEl = root.querySelector('.filters');

  tbody.addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-iso]');
    if (tr) onOpen(tr.dataset.iso);
  });

  function collator() { return new Intl.Collator(isEn() ? 'en' : 'zh-Hant-TW'); }

  // ---- filters UI (rebuilt on language change; state is kept) ----
  function buildFilters() {
    const text = h('input', {
      type: 'search', id: 'f-text', class: 'f-input', autocomplete: 'off', spellcheck: 'false', placeholder: t('f_text_ph'),
    });
    text.value = st.q;
    text.addEventListener('input', () => { st.q = text.value; apply(); });
    const region = h('select', { id: 'f-region', class: 'f-select' },
      h('option', { value: '', text: t('f_region_all') }),
      REGIONS.map((r) => h('option', { value: r, text: regionName(r, model.warnings) })));
    region.value = st.region;
    region.addEventListener('change', () => { st.region = region.value; apply(); });

    const boxes = (set, buckets, chipFn, name) => h('div', { class: 'f-boxes' }, buckets.map((b) => {
      const cb = h('input', { type: 'checkbox', value: b, name, checked: set.has(b) });
      cb.addEventListener('change', () => { if (cb.checked) set.add(b); else set.delete(b); apply(); });
      return h('label', { class: 'f-box' }, cb, chipFn(b));
    }));
    const mofaBoxes = boxes(st.mofa, MOFA_BUCKETS, (b) => (b === 'n' ? mofaChip(null, { size: 'sm', text: t('f_none') }) : mofaChip(+b, { size: 'sm' })), 'f-mofa');
    const cdcBoxes = boxes(st.cdc, CDC_BUCKETS, (b) => cdcChip(+b, { size: 'sm' }), 'f-cdc');
    const attention = h('button', {
      type: 'button', class: 'btn btn-attn', 'aria-pressed': String(st.attention), title: t('f_attention_title'), 'data-testid': 'preset-attention',
    }, h('span', { class: 'attn-dot', 'aria-hidden': 'true' }), h('span', { text: t('f_attention') }));
    attention.addEventListener('click', () => {
      st.attention = !st.attention;
      attention.setAttribute('aria-pressed', String(st.attention));
      apply();
    });
    const reset = h('button', { type: 'button', class: 'btn btn-ghost', text: t('f_reset') });
    reset.addEventListener('click', () => {
      Object.assign(st, { q: '', region: '', attention: false });
      st.mofa = new Set(MOFA_BUCKETS);
      st.cdc = new Set(CDC_BUCKETS);
      buildFilters();
      apply();
    });

    filtersEl.replaceChildren(
      h('div', { class: 'f-row' },
        h('div', { class: 'f-field' }, h('label', { for: 'f-text', text: t('f_text') }), text),
        h('div', { class: 'f-field' }, h('label', { for: 'f-region', text: t('f_region') }), region),
        h('div', { class: 'f-field f-actions' }, attention, reset)),
      h('fieldset', { class: 'f-set' }, h('legend', { text: t('f_mofa') }), mofaBoxes),
      h('fieldset', { class: 'f-set' }, h('legend', { text: t('f_cdc') }), cdcBoxes),
    );
  }

  // ---- header ----
  const COLS = [['name', 'th_name'], ['region', 'th_region'], ['mofa', 'th_mofa'], ['cdc', 'th_cdc'], ['date', 'th_date']];
  function buildHead() {
    thead.replaceChildren(h('tr', {}, COLS.map(([key, label]) => {
      const btn = h('button', { type: 'button', class: 'sort', dataset: { key } },
        h('span', { text: t(label) }), h('span', { class: 'sort-arrow', 'aria-hidden': 'true' }));
      btn.addEventListener('click', () => {
        if (st.sort === key) st.dir = -st.dir; else { st.sort = key; st.dir = DEFAULT_DIR[key]; }
        apply();
      });
      return h('th', { scope: 'col', class: `th-${key}`, dataset: { key } }, btn);
    })));
  }
  function updateHead() {
    thead.querySelectorAll('th').forEach((th) => {
      const on = th.dataset.key === st.sort;
      th.setAttribute('aria-sort', on ? (st.dir > 0 ? 'ascending' : 'descending') : 'none');
      th.querySelector('.sort-arrow').textContent = on ? (st.dir > 0 ? '▲' : '▼') : '';
    });
  }

  // ---- rows ----
  function buildRows() {
    rows = new Map();
    const sep = isEn() ? ', ' : '、';
    for (const d of model.list) {
      const mofaCell = d.w
        ? [mofaChip(d.mofa, { size: 'sm', text: d.mofa == null ? t('mofa_regional_only') : undefined }),
          d.partial ? h('span', { class: 'partial', text: t('partial_level', { n: d.mofaMax }) }) : null]
        : [mofaChip(null, { size: 'sm' })];
      const nDis = d.diseases.length;
      rows.set(d.iso, h('tr', { dataset: { iso: d.iso } },
        h('th', { scope: 'row', class: 'td-name' },
          h('button', { type: 'button', class: 'rowbtn' },
            h('span', { class: 'nm', text: nameOf(d) }),
            h('span', { class: 'alt', lang: isEn() ? 'zh-Hant' : 'en', text: altNameOf(d) }))),
        h('td', { class: 'td-region', 'data-label': t('th_region'), text: regionName(d.region, model.warnings) }),
        h('td', { class: 'td-mofa', 'data-label': d.source === 'mac' ? t('tip_mac') : t('th_mofa') }, mofaCell),
        h('td', { class: 'td-cdc', 'data-label': t('th_cdc') }, cdcChip(d.cdc, { size: 'sm' }),
          nDis ? h('span', { class: 'ndis', title: d.diseases.map(diseaseName).join(sep), text: t('n_diseases', { n: nDis }) }) : null),
        h('td', { class: 'td-date', 'data-label': t('th_date'), text: fmtDay(d.w?.date) || '—' })));
    }
  }

  function matches(d) {
    if (st.region && d.region !== st.region) return false;
    if (!st.mofa.has(mofaBucket(d))) return false;
    if (!st.cdc.has(String(d.cdc))) return false;
    if (st.attention && !needsCare(d)) return false;
    if (st.q) {
      const q = normKey(st.q);
      if (q && !(d.iso.toLowerCase() === q || d.keys.some((k) => k.includes(q)))) return false;
    }
    return true;
  }

  function sorted() {
    const col = collator();
    const byName = (a, b) => col.compare(nameOf(a), nameOf(b));
    const cmp = {
      name: byName,
      region: (a, b) => REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region),
      mofa: (a, b) => mofaRank(a) - mofaRank(b) || (a.mofaMax ?? -1) - (b.mofaMax ?? -1),
      cdc: (a, b) => a.cdc - b.cdc || a.diseases.length - b.diseases.length,
      date: (a, b) => String(a.w?.date || '').localeCompare(String(b.w?.date || '')),
    }[st.sort];
    return [...model.list].sort((a, b) => st.dir * cmp(a, b) || byName(a, b));
  }

  function apply() {
    const list = sorted();
    shown = [];
    const frag = document.createDocumentFragment();
    for (const d of list) {
      const tr = rows.get(d.iso);
      const ok = matches(d);
      tr.hidden = !ok;
      if (ok) shown.push(d);
      frag.append(tr);
    }
    tbody.replaceChildren(frag);
    emptyEl.hidden = shown.length > 0;
    countEl.textContent = t('f_count', { n: shown.length, total: model.list.length });
    updateHead();
  }

  // ---- CSV ----
  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
    return `"${s.replace(/"/g, '""')}"`;
  }
  function exportCsv() {
    const header = ['csv_iso', 'csv_name_zh', 'csv_name_en', 'csv_region', 'csv_mofa', 'csv_mofa_desc', 'csv_mofa_max',
      'csv_mofa_date', 'csv_cdc', 'csv_cdc_diseases', 'csv_mofa_url'].map((k) => t(k));
    const sep = isEn() ? '; ' : '、';
    const lines = [header.map(csvCell).join(',')];
    for (const d of shown) {
      lines.push([
        d.iso, d.nameZh, d.nameEn, regionName(d.region, model.warnings),
        d.w && d.mofa != null ? d.mofa : '',
        d.w ? (d.mofa == null ? t('mofa_regional_only') : mofaFull(d.mofa, d.source)) : t('mofa_nolist'),
        d.partial ? d.mofaMax : '',
        fmtDay(d.w?.date),
        d.cdc,
        d.diseases.map(diseaseName).join(sep),
        safeHref(d.w?.url),
      ].map(csvCell).join(','));
    }
    const blob = new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const stamp = dayAgo();
    const a = h('a', { href: url, download: `${t('csv_file')}-${stamp}.csv`, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  root.querySelector('.t-export').addEventListener('click', exportCsv);
  root.querySelector('.t-print').addEventListener('click', () => onPrint());

  return {
    render(m) {
      model = m;
      buildFilters();
      buildHead();
      buildRows();
      apply();
      root.dataset.lang = getLang();
    },
  };
}
