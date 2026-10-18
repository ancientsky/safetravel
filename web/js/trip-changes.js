// trip.html "recent changes": MOFA level changes, recently updated MOFA warnings, Taiwan CDC changes.
import { h, mofaChip, cdcChip } from './trip-dom.js';
import { t, isEn, nameOf, diseaseName, fmtDay } from './trip-i18n.js';
import { mofaLv, cdcLv, dayAgo } from './trip-data.js';
import { clean } from './util.js';

const HAS_CJK = /[　-鿿＀-￯]/;
const MAX_RECENT = 30;

function entry(model, onOpen, { date, iso, area, what, change }) {
  const d = model.dests.get(iso);
  const name = d ? nameOf(d) : iso;
  const inner = [
    h('time', { class: 'chg-date', datetime: date, text: date }),
    h('span', { class: 'chg-main' },
      h('span', { class: 'chg-name', text: name }),
      area ? h('span', { class: 'chg-area', lang: HAS_CJK.test(area) ? 'zh-Hant' : null, text: area }) : null,
      what ? h('span', { class: 'chg-what', text: what }) : null),
    h('span', { class: 'chg-change' }, change),
  ];
  if (!d) return h('li', {}, h('div', { class: 'chg' }, inner));
  return h('li', {}, h('button', { type: 'button', class: 'chg', onclick: () => onOpen(iso) }, inner));
}

const arrow = () => h('span', { class: 'chg-arrow', text: '→' });
const tag = (key) => h('span', { class: 'chg-tag', text: t(key) });

function list(items, emptyText) {
  if (!items.length) return h('p', { class: 'muted chg-empty', text: emptyText });
  return h('ul', { class: 'chg-list' }, items);
}

export function renderChanges(root, model, onOpen) {
  const W = model.warnings;
  const changes = W?.changes || {};
  const areaText = (zh) => clean(zh) || '';

  // (a) MOFA level changes
  const mofaItems = (Array.isArray(changes.mofa) ? changes.mofa : []).map((c) => {
    const from = mofaLv(c.from);
    const to = mofaLv(c.to);
    let change;
    if (c.from == null) change = [tag('chg_new'), mofaChip(to, { size: 'sm' })];
    else if (c.to == null) change = [mofaChip(from, { size: 'sm' }), arrow(), tag('chg_removed')];
    else change = [mofaChip(from, { size: 'sm' }), arrow(), mofaChip(to, { size: 'sm' })];
    return entry(model, onOpen, { date: fmtDay(c.date), iso: String(c.iso || ''), area: areaText(c.area_zh), change });
  });
  const since = fmtDay(W?.generated_at);
  const mofaEmpty = since ? t('changes_mofa_empty', { d: since }) : t('changes_mofa_empty_nodate');

  // (b) MOFA warnings updated in the last 30 days (country item or area item)
  const cutoff = dayAgo({ days: 30 });
  const recent = [];
  for (const d of model.list) {
    if (!d.w || d.source === 'mac') continue;
    const areaDates = new Set();
    for (const a of d.areas) {
      const ad = fmtDay(a.date);
      if (!ad || ad < cutoff) continue;
      areaDates.add(ad);
      const en = clean(a.area_en);
      const area = isEn() && en && !HAS_CJK.test(en) ? en : clean(a.area_zh);
      recent.push({ date: ad, iso: d.iso, area, lv: mofaLv(a.level) ?? 0 });
    }
    const cd = fmtDay(d.w.date);
    if (cd && cd >= cutoff && !areaDates.has(cd)) recent.push({ date: cd, iso: d.iso, area: '', lv: d.mofa });
  }
  recent.sort((a, b) => b.date.localeCompare(a.date) || a.iso.localeCompare(b.iso));
  const recentItems = recent.slice(0, MAX_RECENT).map((r) => entry(model, onOpen, {
    date: r.date, iso: r.iso, area: r.area,
    change: [r.lv == null ? mofaChip(null, { size: 'sm', text: t('mofa_regional_only') }) : mofaChip(r.lv, { size: 'sm' })],
  }));

  // (c) Taiwan CDC changes
  const cdcItems = (Array.isArray(changes.cdc) ? changes.cdc : []).map((c) => {
    const from = c.from == null ? null : cdcLv(c.from);
    const to = cdcLv(c.to);
    let change;
    if (from == null) change = [tag('chg_new'), cdcChip(to, { size: 'sm' })];
    else if (from === 0) change = [tag('chg_reissued'), cdcChip(to, { size: 'sm' })];
    else if (to === 0) change = [cdcChip(from, { size: 'sm' }), arrow(), tag('chg_lifted')];
    else change = [cdcChip(from, { size: 'sm' }), arrow(), cdcChip(to, { size: 'sm' })];
    const iso = String(c.iso || '');
    let area = areaText(c.area_zh);
    if (area && isEn()) {
      const row = model.dests.get(iso)?.alerts.find((r) => clean(r.area_zh) === area && clean(r.area_en));
      if (row) area = clean(row.area_en);
    }
    return entry(model, onOpen, {
      date: fmtDay(c.date), iso, area, what: diseaseName(c.disease), change,
    });
  });

  root.querySelector('.chg-mofa').replaceChildren(list(mofaItems, mofaEmpty));
  root.querySelector('.chg-recent').replaceChildren(list(recentItems, t('changes_recent_empty')));
  root.querySelector('.chg-cdc').replaceChildren(list(cdcItems, model.alerts ? t('changes_cdc_empty') : t('card_no_cdc_data')));
}
