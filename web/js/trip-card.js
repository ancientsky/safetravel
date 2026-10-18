// trip.html country card: the two official ratings side by side (never merged), recent outbreak news,
// disclaimers. Everything is built with textContent; links pass safeHref().
import { h, extLink, mofaChip, cdcChip } from './trip-dom.js';
import {
  t, isEn, nameOf, altNameOf, mofaFull, cdcFull, cdcShort, cdcInstruction, diseaseName, fmtDay,
} from './trip-i18n.js';
import { loadWarningsText, loadEpidemics, safeHref, mofaLv, cdcLv, dayAgo } from './trip-data.js';
import { clean } from './util.js';

const CDC_COUNTRY_URL = 'https://www.cdc.gov.tw/CountryEpidLevel/Index/NlUwZUNXcFVyb3BGa2tENHNYZXYxdz09';
const HAS_CJK = /[　-鿿＀-￯]/;
const ZH = 'zh-Hant';

let renderToken = 0;

/** Area label: the English title part when it is clean English, else the Chinese name. */
function areaLabel(a) {
  const zh = clean(a.area_zh);
  const en = clean(a.area_en);
  if (isEn() && en && !HAS_CJK.test(en)) return { text: en, lang: 'en' };
  return { text: zh || en, lang: ZH };
}

/** Chinese-only BOCA text; English UI adds a small "Chinese original" label. */
function zhText(text, cls = 'rate-sum') {
  return h('div', { class: cls },
    isEn() ? h('span', { class: 'zh-label', text: t('card_zh_only') }) : null,
    h('p', { lang: ZH, text }));
}

/** <details> that lazy-loads the full BOCA text for item `id`. */
function fullText(id) {
  if (!/^[\w-]{1,32}$/.test(String(id || ''))) return null;
  const body = h('div', { class: 'fulltext', lang: ZH });
  const label = h('span', { text: t('card_expand') });
  const det = h('details', { class: 'more' }, h('summary', {}, label), body);
  det.addEventListener('toggle', async () => {
    label.textContent = det.open ? t('card_collapse') : t('card_expand');
    if (!det.open || body.dataset.loaded) return;
    body.textContent = t('card_loading_text');
    body.setAttribute('aria-busy', 'true');
    try {
      const texts = await loadWarningsText();
      const txt = typeof texts?.[id] === 'string' ? clean(texts[id]) : '';
      body.replaceChildren(isEn() ? h('span', { class: 'zh-label', text: t('card_zh_only') }) : '',
        h('p', { text: txt || t('card_text_missing') }));
      body.dataset.loaded = '1';
    } catch {
      body.textContent = t('card_text_failed');
    }
    body.removeAttribute('aria-busy');
  });
  return det;
}

function meta(items) {
  return h('dl', { class: 'rate-meta' }, items.filter(Boolean).map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: v }))));
}

function mofaBlock(d, model) {
  const mac = d.source === 'mac';
  const w = d.w;
  const head = h('header', { class: 'rate-head' },
    h('h3', { class: 'rate-kicker', text: mac ? t('card_mac_kicker') : t('card_mofa_kicker') }),
    h('p', { class: 'rate-what', text: t('card_mofa_what') }));
  const block = h('article', { class: 'rate rate-mofa', 'aria-label': mac ? t('card_mac_kicker') : t('card_mofa_kicker') }, head);
  if (!w) {
    block.append(
      big('m', null, t('mofa_nolist_full')),
      h('p', { class: 'rate-note', text: model.warnings ? t('card_no_mofa') : t('card_no_mofa_data') }),
      extLink('https://www.boca.gov.tw/sp-trwa-list-1.html', t('foot_boca'), 'ext rate-link'),
    );
    return block;
  }
  const lv = d.mofa;
  block.append(big('m', lv, lv == null ? t('mofa_regional_only') : mofaFull(lv, d.source)));
  if (lv == null && d.mofaMax != null) block.append(h('p', { class: 'rate-note', text: t('card_regional_only', { n: d.mofaMax }) }));
  const date = fmtDay(w.date);
  block.append(meta([
    date && [mac ? t('card_since') : t('card_updated'), date],
    mac && fmtDay(w.confirmed) && [t('card_confirmed_k'), fmtDay(w.confirmed)],
  ]));
  if (mac) {
    const en = clean(w.summary_en);
    if (isEn() && en) block.append(h('div', { class: 'rate-sum' }, h('p', { text: en })));
    else if (w.summary_zh) block.append(zhText(clean(w.summary_zh)));
    block.append(h('p', { class: 'rate-note', text: t('card_mac_manual') }));
  } else if (w.summary_zh) {
    block.append(zhText(clean(w.summary_zh)));
  }
  const more = fullText(w.id);
  if (more) block.append(more);

  if (d.areas.length) {
    const ul = h('ul', { class: 'areas' });
    for (const a of d.areas) {
      const alv = mofaLv(a.level);
      const name = areaLabel(a);
      ul.append(h('li', { class: 'area' },
        h('div', { class: 'area-top' },
          mofaChip(alv ?? 0, { size: 'sm', full: true }),
          h('span', { class: 'area-name', lang: name.lang, text: name.text }),
          fmtDay(a.date) ? h('span', { class: 'area-date', text: fmtDay(a.date) }) : null),
        a.summary_zh ? zhText(clean(a.summary_zh), 'area-sum') : null,
        h('div', { class: 'area-links' }, fullText(a.id), safeHref(a.url) ? extLink(a.url, t('card_link_mofa')) : null)));
    }
    block.append(h('h4', { class: 'areas-h', text: t('card_area_n', { n: d.areas.length }) }), ul);
  }
  block.append(h('p', { class: 'rate-links' },
    extLink(w.url || (mac ? model.warnings?.sources?.mac?.url : ''), mac ? t('card_link_mac') : t('card_link_mofa'), 'ext rate-link')));
  return block;
}

function big(kind, lv, text) {
  const k = lv == null ? 'n' : lv;
  return h('div', { class: `big ${kind}-${k}` },
    h('span', { class: 'big-n', 'aria-hidden': 'true', text: lv == null ? '–' : String(lv) }),
    h('span', { class: 'big-t', text }));
}

function cdcBlock(d, model) {
  const block = h('article', { class: 'rate rate-cdc', 'aria-label': t('card_cdc_kicker') },
    h('header', { class: 'rate-head' },
      h('h3', { class: 'rate-kicker', text: t('card_cdc_kicker') }),
      h('p', { class: 'rate-what', text: t('card_cdc_what') })));
  if (!model.alerts) {
    block.append(big('c', 0, cdcFull(0)), h('p', { class: 'rate-note', text: t('card_no_cdc_data') }));
    block.append(h('p', { class: 'rate-links' }, extLink(CDC_COUNTRY_URL, t('card_link_cdc'), 'ext rate-link')));
    return block;
  }
  block.append(big('c', d.cdc, cdcFull(d.cdc)));
  if (d.cdc) block.append(h('p', { class: 'rate-instr', text: cdcInstruction(d.cdc) }));

  // group rows by disease + level: one line per advisory with its areas
  const groups = new Map();
  for (const r of d.local) {
    const lv = cdcLv(r.level);
    const key = `${r.disease}|${lv}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { disease: r.disease, level: lv, whole: false, areas: [], latest: '' }));
    const area = isEn() ? clean(r.area_en) || clean(r.area_zh) : clean(r.area_zh);
    if (area) g.areas.push(area); else g.whole = true;
    const eff = fmtDay(r.effective);
    if (eff > g.latest) g.latest = eff;
  }
  const list = [...groups.values()].sort((a, b) => b.level - a.level || b.latest.localeCompare(a.latest));
  if (list.length) {
    block.append(h('ul', { class: 'advs' }, list.map((g) => h('li', { class: 'adv' },
      h('div', { class: 'adv-top' }, cdcChip(g.level, { size: 'sm' }), h('span', { class: 'adv-name', text: diseaseName(g.disease) })),
      h('p', { class: 'adv-sub' },
        h('span', {
          text: g.whole && !g.areas.length ? t('card_cdc_whole')
            : `${g.whole ? `${t('card_cdc_whole')}${isEn() ? '; ' : '；'}` : ''}${t('card_cdc_areas')}${isEn() ? ': ' : '：'}${g.areas.join(isEn() ? ', ' : '、')}`,
        }),
        g.latest ? h('span', { class: 'adv-date', text: `${g.areas.length > 1 ? t('card_cdc_latest') : t('card_cdc_effective')} ${g.latest}` }) : null)))));
  } else {
    block.append(h('p', { class: 'rate-note', text: t('card_cdc_none') }));
  }
  const globals = d.alerts.filter((r) => r.global);
  if (globals.length) {
    const items = globals.map((r) => t('card_global_item', {
      disease: diseaseName(r.disease), level: cdcShort(cdcLv(r.level)), date: fmtDay(r.effective),
    }));
    block.append(h('p', { class: 'global-note', text: t('card_global', { list: items.join(isEn() ? '; ' : '；') }) }));
  }
  block.append(h('p', { class: 'rate-links' }, extLink(CDC_COUNTRY_URL, t('card_link_cdc'), 'ext rate-link')));
  return block;
}

function epiSection(d, token) {
  const list = h('div', { class: 'epi-list', 'aria-busy': 'true' }, h('p', { class: 'muted', text: t('card_epi_loading') }));
  const sec = h('section', { class: 'epi', 'aria-labelledby': 'epi-h' },
    h('div', { class: 'epi-head' },
      h('h3', { id: 'epi-h', text: t('card_epi_h') }),
      h('p', { class: 'muted', text: t('card_epi_sub') })),
    list);
  const since = dayAgo({ months: 6 });
  loadEpidemics().then((epi) => {
    if (token !== renderToken) return;
    const items = (Array.isArray(epi?.items) ? epi.items : [])
      .filter((it) => Array.isArray(it?.countries) && it.countries.includes(d.iso) && fmtDay(it.date) >= since)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 3);
    list.removeAttribute('aria-busy');
    if (!items.length) { list.replaceChildren(h('p', { class: 'muted', text: t('card_epi_none') })); return; }
    list.replaceChildren(h('ul', {}, items.map((it) => {
      const en = isEn();
      const head = clean(en ? it.headline_en || it.headline_zh : it.headline_zh || it.headline_en);
      const sum = clean(en ? it.summary_en || it.summary_zh : it.summary_zh || it.summary_en);
      return h('li', { class: 'epi-item' },
        h('time', { datetime: fmtDay(it.date), text: fmtDay(it.date) }),
        h('div', {},
          h('p', { class: 'epi-title', text: head }),
          sum ? h('p', { class: 'epi-sum', text: sum }) : null,
          safeHref(it.url) ? extLink(it.url, t('card_epi_link')) : null));
    })));
  }).catch(() => {
    if (token !== renderToken) return;
    list.removeAttribute('aria-busy');
    list.replaceChildren(h('p', { class: 'muted', text: t('card_epi_failed') }));
  });
  return sec;
}

/** Render destination `d` into the card element. */
export function renderCard(el, d, { model, onClose, onPrint }) {
  const token = ++renderToken;
  el.replaceChildren(
    h('div', { class: 'card-head' },
      h('div', { class: 'card-names' },
        h('p', { class: 'card-kicker' }, h('span', { text: t('card_label') }), h('span', { class: 'iso', text: `${t('card_iso')} ${d.iso}` })),
        h('h2', { id: 'card-title', tabindex: '-1', text: nameOf(d) }),
        h('p', { class: 'card-alt', lang: isEn() ? ZH : 'en', text: altNameOf(d) })),
      h('div', { class: 'card-actions' },
        h('button', { type: 'button', class: 'btn', 'data-testid': 'card-print', onclick: onPrint, text: t('card_print') }),
        h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': t('card_close'), title: t('card_close'), onclick: onClose, text: '×' }))),
    h('div', { class: 'ratings' }, mofaBlock(d, model), cdcBlock(d, model)),
    epiSection(d, token),
    h('div', { class: 'card-disc' },
      h('p', { text: t('card_disclaimer_mofa') }),
      h('p', { text: t('card_disclaimer_cdc') }),
      h('p', { text: t('card_disclaimer_site') })),
  );
  el.dataset.iso = d.iso;
}
