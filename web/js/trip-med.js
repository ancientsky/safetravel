// trip.html country card: "出國前健康準備" from Taiwan CDC's 國際旅遊處方箋 (travelmed.json + travelmed/<ISO>.json).
// Vaccines and preventive medicine with CDC's own explanation, local diseases by route of transmission with the advice,
// care during the trip (the Taiwan mission's emergency line) and after return. Notes for six kinds of traveller
// (infants, pregnancy, chronic illness, immunocompromised, long stays, aid workers) appear when the traveller picks
// them. Text only (textContent); CDC's page text is Chinese, labelled as such in the English UI.
import { h, extLink } from './trip-dom.js';
import { t, isEn } from './trip-i18n.js';
import { loadTravelmed, loadTravelmedDetail, telHref } from './trip-data.js';
import { storageGet, storageSet, clean } from './util.js';

export const GROUPS = ['infants', 'pregnancy', 'chronic', 'immuno', 'longstay', 'aid'];
const GROUP_KEY = 'safetravel.trip.groups';
const ZH = 'zh-Hant';
const PAGE_URL = 'https://www.cdc.gov.tw/Internationaltravel/Index/ZkNLTkRxQ0NyQmc5Rk50dmZZZlI2Zz09';
// disease group (CSV 次類別) → advice group (CSV 主類別) shown on the same card
const DIS_ADV = { vector: 'bites', food: 'food', contact: 'animals', other: 'other' };
const ICONS = {
  vector: 'M12 7.5c2 0 3.5 1.8 3.5 4.5S14 17 12 17s-3.5-2.3-3.5-5S10 7.5 12 7.5zM12 7.5V5M9.5 4l2.5 1.5L14.5 4M8.5 11 4 9M8.5 13.5 4 15M15.5 11 20 9M15.5 13.5 20 15M10 17.5l-1.5 2.5M14 17.5l1.5 2.5',
  food: 'M6 3v7a2 2 0 0 0 4 0V3M8 3v18M17 3c-2 2-2.5 5-2.5 7.5S16 13 17 13v8',
  contact: 'M7.5 10.5a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM16.5 10.5a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM5 6a1.6 1.6 0 1 1 3.2 0M15.8 6A1.6 1.6 0 1 1 19 6M12 12.5c3 0 5.5 2.6 5.5 5.2 0 1.6-1.5 2.3-3 1.8-1-.4-1.6-.6-2.5-.6s-1.5.2-2.5.6c-1.5.5-3-.2-3-1.8 0-2.6 2.5-5.2 5.5-5.2z',
  other: 'M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6zM12 8v5M12 16v.5',
  water: 'M3 15c2 0 2-1.5 4.5-1.5S10 15 12 15s2-1.5 4.5-1.5S19 15 21 15M3 19c2 0 2-1.5 4.5-1.5S10 19 12 19s2-1.5 4.5-1.5S19 19 21 19M12 3s-4 4.5-4 7a4 4 0 0 0 8 0c0-2.5-4-7-4-7z',
  syringe: 'M18 2l4 4M20 4l-9.5 9.5M14 4l6 6M15.5 8.5 8 16H5v-3l7.5-7.5M5 16l-3 3M9 9l2 2M7 11l2 2',
  phone: 'M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z',
};

let groups = new Set(readGroups());
function readGroups() {
  try {
    const v = JSON.parse(storageGet(GROUP_KEY) || '[]');
    return Array.isArray(v) ? v.filter((g) => GROUPS.includes(g)) : [];
  } catch { return []; }
}

const icon = (k) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'med-ico');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', ICONS[k] || ICONS.other);
  svg.append(p);
  return svg;
};

const term = (tm, i) => tm.terms?.[i] || null;
const termText = (x) => clean(isEn() ? x.en || x.zh : x.zh);
const vaxName = (tm, name) => {
  const v = tm.vaccines?.[name];
  return clean(isEn() ? v?.en || name : name);
};

/** Chinese-only text block: the English UI gets a small "Chinese original" label first. */
function zhBlock(...kids) {
  return h('div', { class: 'med-zh', lang: ZH }, isEn() ? h('span', { class: 'zh-label', lang: 'en', text: t('med_zh_only') }) : null, kids);
}

/** Flattened CDC rich text: paragraphs, bullets (depth), sub-headings, bold labels and traveller-group notes. */
function linesEl(lines) {
  const box = h('div', { class: 'med-lines' });
  for (const ln of Array.isArray(lines) ? lines : []) {
    const text = clean(ln?.t);
    if (!text) continue;
    const d = Math.min(Number(ln.d) || 0, 3);
    const g = GROUPS.includes(ln.g) ? ln.g : null;
    const cls = ['med-ln', ln.h ? 'med-ln-h' : '', d ? `med-d${d}` : '', g ? 'med-ln-g' : ''].filter(Boolean).join(' ');
    box.append(h('p', { class: cls, 'data-g': g },
      g ? h('span', { class: 'med-gtag', lang: isEn() ? 'en' : null, text: t(`med_g_${g}_s`) }) : null,
      ln.k ? h('b', { text: `${clean(ln.k)}${isEn() ? ': ' : '：'}` }) : null,
      text));
  }
  return box;
}

const groupCount = (lines, g) => (Array.isArray(lines) ? lines.filter((ln) => ln?.g === g).length : 0);

function details(cls, summary, body, open = false) {
  const det = h('details', { class: `med-det ${cls}` }, h('summary', {}, summary), body);
  if (open) det.open = true;
  return det;
}

// ---------------------------------------------------------------- blocks
function whenBlock(onClinics) {
  return h('div', { class: 'med-when' },
    icon('syringe'),
    h('div', { class: 'med-when-t' },
      h('p', { class: 'med-when-h', text: t('med_when') }),
      h('p', { class: 'med-when-s', text: t('med_when_sub') })),
    h('button', { type: 'button', class: 'btn btn-go', 'data-testid': 'med-find-clinic', onclick: onClinics }, t('med_find_clinic'), h('span', { 'aria-hidden': 'true', text: ' →' })));
}

function groupBar(sec, page) {
  const all = page ? [...(page.vaccines || []).flatMap((v) => v.lines || []), ...Object.values(page.sections || {}).flat()] : [];
  const bar = h('div', { class: 'med-groups', role: 'group', 'aria-labelledby': 'med-groups-l' },
    h('span', { id: 'med-groups-l', class: 'med-groups-l', text: t('med_groups_l') }));
  for (const g of GROUPS) {
    const n = groupCount(all, g);
    const b = h('button', {
      type: 'button', class: 'med-gbtn', 'aria-pressed': String(groups.has(g)), 'data-g': g, 'data-testid': `med-group-${g}`,
      disabled: n ? null : true, title: n ? t('med_group_n', { n }) : t('med_group_none'),
    }, h('span', { text: t(`med_g_${g}`) }), n ? h('span', { class: 'med-gbtn-n', text: String(n) }) : null);
    b.addEventListener('click', () => {
      if (groups.has(g)) groups.delete(g); else groups.add(g);
      storageSet(GROUP_KEY, JSON.stringify([...groups]));
      b.setAttribute('aria-pressed', String(groups.has(g)));
      applyGroups(sec);
    });
    bar.append(b);
  }
  return bar;
}

function applyGroups(sec) {
  for (const g of GROUPS) sec.classList.toggle(`show-${g}`, groups.has(g));
  // open the rows that carry a note for a group that was just switched on
  sec.querySelectorAll('.med-vax').forEach((det) => {
    const hit = [...groups].some((g) => det.querySelector(`.med-ln[data-g="${g}"]`));
    det.classList.toggle('has-g', hit);
  });
}

function vaxBlock(tm, entry, page) {
  const rows = page?.vaccines?.length ? page.vaccines : (entry.vax || []).map((name) => ({ name, lines: [] }));
  if (!rows.length) return null;
  const list = h('div', { class: 'med-vaxes' });
  for (const v of rows) {
    const name = clean(v.name);
    const meta = tm.vaccines?.[name];
    const lines = Array.isArray(v.lines) ? v.lines : [];
    const first = lines.find((ln) => !ln.g && !ln.h);
    const gtags = GROUPS.filter((g) => groupCount(lines, g)).map((g) => h('span', { class: 'med-gtag', 'data-g': g, text: t(`med_g_${g}_s`) }));
    const summary = [
      h('span', { class: 'med-vax-name', lang: isEn() && !meta?.en ? ZH : null, text: vaxName(tm, name) }),
      gtags.length ? h('span', { class: 'med-gtags' }, gtags) : null,
      first && !isEn() ? h('span', { class: 'med-vax-pre', text: `${first.k ? `${clean(first.k)}：` : ''}${clean(first.t)}` }) : null,
    ];
    const body = lines.length ? zhBlock(linesEl(lines)) : h('p', { class: 'muted', text: t('med_vax_nopage') });
    const det = details('med-vax', summary, body);
    det.dataset.testid = 'med-vax';
    list.append(det);
  }
  return h('div', { class: 'med-block' },
    h('h4', { class: 'med-bh' }, icon('syringe'), h('span', { text: t('med_vax_h') })),
    h('p', { class: 'med-note', text: t('med_vax_note') }),
    list);
}

function diseaseBlock(tm, entry, page) {
  const cards = [];
  for (const g of ['vector', 'food', 'contact', 'other']) {
    const ids = entry.dis?.[g] || [];
    const adv = entry.adv?.[DIS_ADV[g]] || [];
    if (!ids.length && !adv.length) continue;
    cards.push(h('div', { class: `med-dis med-dis-${g}` },
      h('p', { class: 'med-dis-h' }, icon(g), h('span', { text: t(`med_dis_${g}`) })),
      ids.length ? h('ul', { class: 'med-chips' }, ids.map((i) => term(tm, i)).filter(Boolean).map(diseaseChip)) : null,
      adv.length ? h('ul', { class: 'med-adv' }, adv.map((i) => term(tm, i)).filter(Boolean).map((x) => h('li', { text: termText(x) }))) : null));
  }
  if (entry.adv?.water?.length) {
    cards.push(h('div', { class: 'med-dis med-dis-water' },
      h('p', { class: 'med-dis-h' }, icon('water'), h('span', { text: t('med_dis_water') })),
      h('ul', { class: 'med-adv' }, entry.adv.water.map((i) => term(tm, i)).filter(Boolean).map((x) => h('li', { text: termText(x) })))));
  }
  if (!cards.length) return null;
  const full = page?.sections?.diseases;
  return h('div', { class: 'med-block' },
    h('h4', { class: 'med-bh' }, icon('other'), h('span', { text: t('med_dis_h') })),
    h('div', { class: 'med-dis-grid' }, cards),
    full?.length ? details('med-full', t('med_dis_full'), zhBlock(linesEl(full))) : null);
}

/** "新型A型流感(近5年禽鳥有檢出H5N1病毒)" → base name with the qualifier in small print. */
function diseaseChip(x) {
  const full = termText(x);
  const m = /^(.+?)\s*\((.+)\)$/.exec(full);
  return m ? h('li', { title: full }, m[1], ' ', h('small', { text: `(${m[2]})` })) : h('li', { text: full });
}

/** [{where, tel}] → "河內 +84-…" tel: links (one per Taiwan mission). */
function hotlineLinks(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && telHref(x.tel)).map((x) => h('span', { class: 'med-sos-one' },
    x.where ? h('span', { class: 'med-sos-x', lang: ZH, text: clean(x.where) }) : null,
    h('a', { class: 'med-tel', href: telHref(x.tel), text: clean(x.tel) })));
}

function duringBlock(page) {
  const during = page?.sections?.during;
  const after = page?.sections?.after;
  if (!page) return null;
  const tel = h('div', { class: 'med-sos' },
    icon('phone'),
    h('div', {},
      h('p', { class: 'med-sos-h', text: t('med_sos_h') }),
      hotlineLinks(page.hotline).length
        ? h('p', { class: 'med-sos-n' }, h('span', { class: 'med-sos-k', text: t('med_sos_mission') }), hotlineLinks(page.hotline)) : null,
      h('p', { class: 'med-sos-n' }, h('span', { class: 'med-sos-k', text: t('med_sos_boca') }),
        h('a', { class: 'med-tel', href: 'tel:0800085095', text: '0800-085-095' }),
        h('span', { class: 'med-sos-x', text: t('med_sos_boca_abroad') }),
        h('a', { class: 'med-tel', href: 'tel:+886800085095', text: '+886-800-085-095' })),
      h('p', { class: 'med-sos-n' }, h('span', { class: 'med-sos-k', text: t('med_sos_cdc') }),
        h('a', { class: 'med-tel', href: 'tel:1922', text: '1922' }),
        h('span', { class: 'med-sos-x', text: t('med_sos_boca_abroad') }),
        h('a', { class: 'med-tel', href: 'tel:+886800001922', text: '+886-800-001922' }))));
  return h('div', { class: 'med-block' },
    h('h4', { class: 'med-bh' }, icon('phone'), h('span', { text: t('med_during_h') })),
    tel,
    during?.length ? details('med-full', t('med_during_full'), zhBlock(linesEl(during))) : null,
    after?.length ? details('med-full', t('med_after_full'), zhBlock(linesEl(after))) : null);
}

function beforeBlock(page) {
  const lines = page?.sections?.before;
  if (!lines?.length) return null;
  return details('med-full med-before', t('med_before_full'), zhBlock(linesEl(lines)));
}

// ---------------------------------------------------------------- section
/**
 * The card section for destination `d`. `alive()` is false once another card replaced this one;
 * `onClinics()` jumps to the clinic finder.
 */
export function medSection(d, { alive, onClinics }) {
  const body = h('div', { class: 'med-body', 'aria-busy': 'true' }, h('p', { class: 'muted', text: t('med_loading') }));
  const foot = h('p', { class: 'med-foot' });
  const sec = h('section', { class: 'med', 'aria-labelledby': 'med-h', 'data-testid': 'med' },
    h('div', { class: 'med-head' },
      h('h3', { id: 'med-h', text: t('med_h') }),
      h('p', { class: 'med-sub', text: t('med_sub') })),
    body, foot);
  applyGroups(sec);
  loadTravelmed().then(async (tm) => {
    // the detail file exists only for destinations whose CDC page has been read (countries[iso].page)
    const det = tm?.countries?.[d.iso]?.page ? await loadTravelmedDetail(d.iso).catch(() => null) : null;
    return [tm, det];
  }).then(([tm, det]) => {
    if (!alive()) return;
    body.removeAttribute('aria-busy');
    const entry = tm?.countries?.[d.iso];
    if (!entry) {
      body.replaceChildren(h('p', { class: 'muted', text: t('med_none') }), whenBlock(onClinics));
      foot.replaceChildren(extLink(PAGE_URL, t('med_link')));
      return;
    }
    // CDC lists some islands separately (Canary Islands, Azores, Madeira, Easter Island, Tahiti …)
    const places = [{ b: entry, page: det?.page || null }];
    for (const sb of entry.subs || []) {
      places.push({ b: sb, page: (det?.subs || []).find((x) => x.zh === sb.zh)?.page || null });
    }
    const content = h('div', { class: 'med-place' });
    const show = (i) => {
      const { b, page } = places[i];
      content.replaceChildren(...[
        groupBar(sec, page),
        vaxBlock(tm, b, page),
        diseaseBlock(tm, b, page),
        duringBlock(page),
        beforeBlock(page),
      ].filter(Boolean));
      applyGroups(sec);
    };
    const kids = [whenBlock(onClinics)];
    if (places.length > 1) {
      const tabs = h('div', { class: 'med-places', role: 'group', 'aria-label': t('med_places') });
      places.forEach((p, i) => {
        const b = h('button', {
          type: 'button', class: 'med-pbtn', 'aria-pressed': String(i === 0),
          text: isEn() ? clean(p.b.en) || clean(p.b.zh) : clean(p.b.zh),
        });
        b.addEventListener('click', () => {
          tabs.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          show(i);
        });
        tabs.append(b);
      });
      kids.push(tabs);
    }
    kids.push(content);
    body.replaceChildren(...kids);
    show(0);
    const checked = /^\d{4}-\d{2}-\d{2}$/.test(String(det?.checked || '')) ? det.checked : '';
    foot.replaceChildren(
      h('span', { text: checked ? t('med_foot_checked', { d: checked }) : t('med_foot') }),
      ' ',
      extLink(det?.url || PAGE_URL, t('med_link')));
  }).catch(() => {
    if (!alive()) return;
    body.removeAttribute('aria-busy');
    body.replaceChildren(h('p', { class: 'muted', text: t('med_failed') }));
    foot.replaceChildren(extLink(PAGE_URL, t('med_link')));
  });
  return sec;
}

/** Printing a card prints every collapsed CDC text too. */
let reopen = [];
window.addEventListener('beforeprint', () => {
  reopen = [...document.querySelectorAll('#card .med details:not([open])')];
  reopen.forEach((det) => { det.open = true; });
});
window.addEventListener('afterprint', () => {
  reopen.forEach((det) => { det.open = false; });
  reopen = [];
});
