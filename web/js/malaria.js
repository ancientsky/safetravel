// malaria.html — 瘧疾預防用藥試算 (draft, pending review by physicians). Itinerary + traveller → does the trip call for
// malaria prophylaxis (Taiwan CDC's own wording per country, data/malaria.json), which of the three drugs CDC lists
// can be considered, the dosing schedule, number of doses and tablets, an optional cost, and reminders for Google
// Calendar / any calendar app (.ics). Nothing typed here is stored or sent anywhere.
import { storageGet, storageSet, clean, urlLang, syncUrlLang, safeUrl } from './util.js';
import { bindTextSize } from './textsize.js';
import { createMalariaMap } from './malaria-map.js';
import zh from '../i18n/malaria-zh-Hant.js';
import en from '../i18n/malaria-en.js';
import {
  DRUGS, WHO_NOTES, SOURCE_URL, SOURCE_DATE, riskWindow, verdict, doseFor, assess, schedule, tabletsToBuy, buildICS,
  googleCalendarUrl, addDays, daysBetween, dayMs,
} from './malaria-calc.js';

document.documentElement.dataset.booted = '1'; // js/boot-guard.js

const LANG_KEY = 'safetravel.lang';
const THEME_KEY = 'safetravel.trip.theme';
const root = document.documentElement;
const $ = (s, el = document) => el.querySelector(s);
let lang = urlLang() || (storageGet(LANG_KEY) === 'en' ? 'en' : 'zh-Hant');
const isEn = () => lang === 'en';

function t(key, p = {}) {
  const v = (isEn() ? en : zh)[key] ?? zh[key];
  if (v == null) return key;
  if (typeof v === 'function') return v(p);
  return String(v).replace(/\{(\w+)\}/g, (_, k) => (p[k] ?? ''));
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false || kid === '') continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

// ---------------------------------------------------------------- state (memory only)
const state = {
  data: null,
  legs: [],
  person: {},
  drug: Object.fromEntries(DRUGS.map((d) => [d.id, { lead: d.lead[0] === 1 ? 2 : 2, time: '08:00', price: '' }])),
};
let legSeq = 0;
const newLeg = () => ({ id: ++legSeq, iso: '', sub: -1, arrive: '', depart: '', visit: 'unsure' });

function entryOf(leg) {
  const c = state.data?.countries?.[leg.iso];
  if (!c) return null;
  return leg.sub >= 0 && c.subs?.[leg.sub] ? c.subs[leg.sub] : c;
}
const placeName = (e) => clean(isEn() ? e.en || e.zh : e.zh);

/** Legs in the shape malaria-calc expects. */
function calcLegs() {
  return state.legs.map((l) => {
    const e = entryOf(l);
    return { arrive: l.arrive, depart: l.depart, risk: e?.risk || '', visit: l.visit, mef: !!e?.mef_resistant, entry: e, leg: l };
  });
}

// ---------------------------------------------------------------- CDC text
function linesEl(lines) {
  const box = h('div', { class: 'ml-lines', lang: 'zh-Hant' });
  for (const ln of lines || []) {
    const d = Math.min(Number(ln.d) || 0, 3);
    box.append(h('p', { class: `ml-ln${d ? ` d${d}` : ''}${ln.h ? ' ml-ln-h' : ''}` },
      ln.k ? h('b', { text: `${clean(ln.k)}：` }) : null, clean(ln.t)));
  }
  return box;
}
const zhLabel = () => (isEn() ? h('span', { class: 'zh-label', lang: 'en', text: t('zh_only') }) : null);

// ---------------------------------------------------------------- step 1: itinerary
function countryOptions(sel) {
  const cs = Object.entries(state.data?.countries || {});
  const coll = new Intl.Collator(isEn() ? 'en' : 'zh-Hant-TW-u-co-stroke');
  const groups = { drug: [], bites: [], unknown: [], none: [] };
  for (const [iso, c] of cs) (groups[c.risk] || groups.none).push([iso, c]);
  sel.append(h('option', { value: '', text: t('pick_country') }));
  for (const g of ['drug', 'unknown', 'bites', 'none']) {
    if (!groups[g].length) continue;
    const og = h('optgroup', { label: t(`grp_${g}`) });
    groups[g].sort((a, b) => coll.compare(placeName(a[1]), placeName(b[1])))
      .forEach(([iso, c]) => og.append(h('option', { value: iso, text: placeName(c) })));
    sel.append(og);
  }
}

function riskBadge(e) {
  const r = e?.risk || 'none';
  return h('span', { class: `ml-risk ml-risk-${r}`, text: t(`risk_${r}`) });
}

function legEl(leg, i) {
  const li = h('li', { class: 'ml-leg', 'data-testid': 'leg' });
  const sel = h('select', { class: 'f-input ml-country', id: `c-${leg.id}`, 'data-testid': 'leg-country' });
  countryOptions(sel);
  sel.value = leg.iso;
  sel.addEventListener('change', () => { leg.iso = sel.value; leg.sub = -1; leg.visit = 'unsure'; renderLegs(); renderResult(); });
  const arrive = h('input', { type: 'date', class: 'f-input', id: `a-${leg.id}`, value: leg.arrive, 'data-testid': 'leg-arrive' });
  const depart = h('input', { type: 'date', class: 'f-input', id: `d-${leg.id}`, value: leg.depart, 'data-testid': 'leg-depart' });
  arrive.addEventListener('change', () => {
    leg.arrive = arrive.value;
    if (leg.arrive && (!leg.depart || leg.depart < leg.arrive)) { leg.depart = ''; depart.value = ''; }
    depart.min = leg.arrive;
    renderResult();
  });
  depart.min = leg.arrive;
  depart.addEventListener('change', () => { leg.depart = depart.value; renderResult(); });
  const c = state.data?.countries?.[leg.iso];
  const remove = state.legs.length > 1
    ? h('button', { type: 'button', class: 'btn btn-icon ml-del', 'aria-label': t('remove_leg'), title: t('remove_leg'), text: '×',
      onclick: () => { state.legs = state.legs.filter((x) => x !== leg); renderLegs(); renderResult(); } }) : null;
  li.append(h('div', { class: 'ml-leg-row' },
    h('span', { class: 'ml-leg-n', 'aria-hidden': 'true', text: String(i + 1) }),
    h('div', { class: 'f-field ml-f-country' }, h('label', { for: sel.id, text: t('country') }), sel),
    c?.subs?.length ? subSelect(leg, c) : null,
    h('div', { class: 'f-field' }, h('label', { for: arrive.id, text: t('arrive') }), arrive),
    h('div', { class: 'f-field' }, h('label', { for: depart.id, text: t('depart') }), depart),
    remove));
  const e = entryOf(leg);
  if (e) {
    const info = h('div', { class: `ml-cdc ml-cdc-${e.risk}` },
      h('p', { class: 'ml-cdc-h' }, riskBadge(e), h('span', { text: t(`risk_${e.risk}_d`) })));
    if (e.lines?.length) info.append(...[zhLabel(), linesEl(e.lines)].filter(Boolean));
    const who = WHO_NOTES[leg.iso];
    if (who && leg.sub < 0) {
      info.append(h('p', { class: 'ml-who-note', 'data-testid': 'who-note' },
        h('b', { text: t('who_note_h') }), ' ', isEn() ? who.en : who.zh, ' ', t('who_note_tail')));
    }
    if (e.risk === 'drug' || e.risk === 'unknown') {
      const q = h('div', { class: 'ml-visit', role: 'radiogroup', 'aria-label': t('visit_q') },
        h('span', { class: 'ml-visit-q', text: t('visit_q') }));
      for (const v of ['yes', 'unsure', 'no']) {
        const id = `v-${leg.id}-${v}`;
        const r = h('input', { type: 'radio', name: `v-${leg.id}`, id, value: v, 'data-testid': `visit-${v}` });
        r.checked = leg.visit === v;
        r.addEventListener('change', () => { leg.visit = v; renderResult(); });
        q.append(h('label', { for: id, class: 'ml-radio' }, r, ' ', t(`visit_${v}`)));
      }
      info.append(q);
    }
    li.append(info);
  }
  return li;
}

function subSelect(leg, c) {
  const id = `s-${leg.id}`;
  const sel = h('select', { class: 'f-input', id },
    h('option', { value: '-1', text: placeName(c) }),
    c.subs.map((s, i) => h('option', { value: String(i), text: placeName(s) })));
  sel.value = String(leg.sub);
  sel.addEventListener('change', () => { leg.sub = Number(sel.value); leg.visit = 'unsure'; renderLegs(); renderResult(); });
  return h('div', { class: 'f-field' }, h('label', { for: id, text: t('area') }), sel);
}

function renderLegs() {
  const ol = $('.ml-legs');
  ol.replaceChildren(...state.legs.map(legEl));
  map?.mark(state.legs.map((l) => l.iso));
}

// ---------------------------------------------------------------- risk map
let map = null;

/** A country clicked on the map: fill the first empty stop, else add one after the last. */
function pickCountry(iso) {
  let leg = state.legs.find((l) => !l.iso);
  if (!leg) {
    const prev = state.legs.at(-1);
    leg = newLeg();
    if (prev?.depart) leg.arrive = prev.depart;
    state.legs.push(leg);
  }
  leg.iso = iso;
  leg.sub = -1;
  leg.visit = 'unsure';
  renderLegs();
  renderResult();
  const n = state.legs.indexOf(leg) + 1;
  const go = h('button', { type: 'button', class: 'btn btn-ghost', 'data-testid': 'map-fill-dates', text: t('map_fill_dates') });
  go.addEventListener('click', () => {
    const el = $(`#a-${leg.id}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.focus({ preventScroll: true });
  });
  $('.mm-status').replaceChildren(t('map_added', { name: placeName(state.data.countries[iso]), n }), ' ', go);
}

function renderMapSource() {
  const who = state.data?.who?.source;
  const el = $('.mm-src');
  // data-driven links: https cdc.gov.tw only (safeUrl), otherwise plain text
  const link = (href, text) => (safeUrl(href) ? h('a', { href: safeUrl(href), target: '_blank', rel: 'noopener noreferrer', text }) : text);
  el.replaceChildren(...[
    h('b', { text: t('map_src_h') }),
    t('map_src_who'),
    who?.image ? link(who.image, t('map_src_orig')) : null,
    who?.via ? [t('map_src_via'), link(who.via, t('map_src_via_link')), t('map_src_end')] : null,
    t('map_src_caveat'),
    t('map_src_cdc'),
    t('map_src_borders'),
  ].flat().filter((x) => x != null && x !== ''));
}

async function initMap() {
  const box = $('.mm-box');
  try {
    if (!state.data) throw new Error('no data');
    const narrow = window.innerWidth < 760;
    const r = await fetch(narrow ? 'data/world-110m.json' : 'data/world.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const world = await r.json();
    map = createMalariaMap({
      box, svgEl: $('.mm-svg'), tipEl: $('.mm-tip'), legendEl: $('.mm-legend'), data: state.data, t, isEn, onPick: pickCountry,
    });
    map.render(world);
    map.mark(state.legs.map((l) => l.iso));
    $('.mm-loading').hidden = true;
    $('.mm-zin').addEventListener('click', () => map.zoomBy(1.6));
    $('.mm-zout').addEventListener('click', () => map.zoomBy(1 / 1.6));
    $('.mm-zreset').addEventListener('click', () => map.reset());
    const tabs = [...document.querySelectorAll('.mm-tab')];
    const setLayer = (l, focus) => {
      tabs.forEach((b) => {
        const on = b.dataset.layer === l;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      });
      map.setLayer(l);
    };
    tabs.forEach((b, i) => {
      b.addEventListener('click', () => setLayer(b.dataset.layer));
      b.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
          ev.preventDefault();
          setLayer(tabs[(i + 1) % tabs.length].dataset.layer, true);
        }
      });
    });
  } catch (e) {
    console.warn('malaria: map unavailable', e);
    $('.mm-loading').textContent = t('map_failed');
  }
}

// ---------------------------------------------------------------- step 2: traveller
function readPerson() {
  const num = (id) => { const v = parseFloat($(`#${id}`).value); return Number.isFinite(v) ? v : NaN; };
  const p = { age: num('age'), weight: num('weight'), pregnant: $('#pregnant').value };
  document.querySelectorAll('.ml-checks input[data-k]').forEach((cb) => { p[cb.dataset.k] = cb.checked; });
  $('.ml-sub').hidden = !p.breastfeeding;
  if (!p.breastfeeding) p.infantUnder5 = false;
  state.person = p;
}

// ---------------------------------------------------------------- step 3: result
const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(`${s}T00:00:00Z`);
  const wd = d.getUTCDay();
  return isEn() ? `${s} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd]})` : `${s}（${'日一二三四五六'[wd]}）`;
};
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(+n.toFixed(2)));
const frac = (x) => ({ 0.25: '¼', 0.5: '½', 0.75: '¾' }[x] || fmtNum(x));

function doseText(drug, dose) {
  if (dose.tablets != null) return t('dose_tabs', { n: frac(dose.tablets), mg: dose.mg ? ` ${dose.mg} mg` : '' });
  if (dose.mg != null) return t('dose_mg', { mg: fmtNum(dose.mg) });
  return t('dose_doctor');
}

function regimenText(drug) {
  if (drug.freq === 'weekly') return t('reg_weekly', { a: drug.lead[0], b: drug.lead[1], after: drug.afterDays / 7 });
  return t('reg_daily', { a: drug.lead[0], b: drug.lead[1], after: drug.afterDays === 28 ? t('four_weeks') : t('days_n', { n: drug.afterDays }) });
}

function timeline(win, sch, drug) {
  const total = daysBetween(sch.first, sch.last) + 1;
  const pct = (a, b) => `${((daysBetween(a, b)) / total) * 100}%`;
  const bar = h('div', { class: 'ml-tl', role: 'img', 'aria-label': t('tl_label', { a: sch.first, b: sch.last }) },
    h('span', { class: 'ml-tl-pre' }),
    h('span', { class: 'ml-tl-in' }),
    h('span', { class: 'ml-tl-post' }));
  // widths via CSS custom properties (style-src 'self' allows CSSOM, not inline style attributes)
  bar.style.setProperty('--pre', pct(sch.first, win.start));
  bar.style.setProperty('--in', pct(win.start, addDays(win.end, 1)));
  bar.style.setProperty('--post', pct(addDays(win.end, 1), addDays(sch.last, 1)));
  const legend = h('div', { class: 'ml-tl-l' },
    h('span', { class: 'k-pre', text: t('tl_pre', { n: daysBetween(sch.first, win.start) }) }),
    h('span', { class: 'k-in', text: t('tl_in', { n: win.days }) }),
    h('span', { class: 'k-post', text: t('tl_post', { n: daysBetween(win.end, sch.last) }) }));
  return h('div', { class: 'ml-tlw' }, bar, legend, drug.freq === 'weekly' ? h('p', { class: 'ml-note', text: t('weekly_same_day', { d: fmtDate(sch.first) }) }) : null);
}

function calendarBlock(drug, sch, dose, win) {
  const st = state.drug[drug.id];
  const time = h('input', { type: 'time', class: 'f-input ml-time', id: `tm-${drug.id}`, value: st.time, 'data-testid': `time-${drug.id}` });
  const name = isEn() ? drug.en : `${drug.en}（${drug.zh}）`;
  const amount = doseText(drug, dose);
  const ev = () => ({
    uid: `${drug.id}-${sch.first}-${sch.doses}@safetravel.tw`,
    title: t('cal_title', { name: drug.en, amount }),
    desc: t('cal_desc', {
      name, amount, freq: t(drug.freq === 'weekly' ? 'freq_weekly' : 'freq_daily'), first: sch.first, last: sch.last, n: sch.doses,
      start: win.start, end: win.end,
    }),
    first: sch.first, time: st.time || '08:00', freq: drug.freq === 'weekly' ? 'WEEKLY' : 'DAILY', count: sch.doses,
  });
  const gcal = h('a', { class: 'btn ml-cal', target: '_blank', rel: 'noopener noreferrer', 'data-testid': `gcal-${drug.id}`, text: t('cal_google') });
  const setHref = () => { gcal.href = googleCalendarUrl(ev()); };
  setHref();
  time.addEventListener('change', () => { st.time = time.value || '08:00'; setHref(); });
  const ics = h('button', { type: 'button', class: 'btn ml-cal', 'data-testid': `ics-${drug.id}`, text: t('cal_ics') });
  ics.addEventListener('click', () => {
    const watch = {
      uid: `watch-${win.end}@safetravel.tw`, title: t('cal_watch_title'), desc: t('cal_watch_desc'),
      day: addDays(win.end, 1), endDay: addDays(win.end, 91),
    };
    const blob = new Blob([buildICS([ev(), watch])], { type: 'text/calendar;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `malaria-${drug.id}-${sch.first}.ics` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  return h('div', { class: 'ml-calb' },
    h('div', { class: 'f-field' }, h('label', { for: time.id, text: t('cal_time') }), time),
    gcal, ics,
    h('p', { class: 'ml-note', text: t('cal_note') }));
}

function drugCard(drug, win) {
  const p = state.person;
  const a = assess(drug, p, win);
  const st = state.drug[drug.id];
  const card = h('article', { class: `ml-drug ml-st-${a.status}`, 'data-testid': `drug-${drug.id}`, 'data-status': a.status });
  card.append(h('header', { class: 'ml-drug-h' },
    h('div', {},
      h('h3', {}, h('span', { text: drug.en }), drug.brand ? h('span', { class: 'ml-brand', text: ` ${drug.brand}` }) : null),
      h('p', { class: 'ml-drug-zh', lang: 'zh-Hant', text: drug.zh })),
    h('span', { class: `ml-st ml-st-${a.status}`, text: t(`st_${a.status}`) })));
  if (a.reasons.length) {
    card.append(h('ul', { class: 'ml-reasons' }, a.reasons.map((r) => h('li', { class: r === 'r_dox_sun' ? 'ml-r-info' : '', text: t(r) }))));
  }
  if (a.status === 'no' || a.status === 'covered') return card;

  const dose = doseFor(drug, p);
  const leadSel = h('select', { class: 'f-input', id: `ld-${drug.id}`, 'data-testid': `lead-${drug.id}` },
    drug.lead.map((n) => h('option', { value: String(n), text: t(drug.freq === 'weekly' ? 'lead_weeks' : 'lead_days', { n }) })));
  if (!drug.lead.includes(st.lead)) st.lead = drug.lead[drug.freq === 'weekly' ? 0 : 1];
  leadSel.value = String(st.lead);
  leadSel.addEventListener('change', () => { st.lead = Number(leadSel.value); renderResult(); });
  const sch = schedule(drug, win, st.lead);
  const buy = dose.tablets != null ? tabletsToBuy(dose.tablets, sch.doses) : null;
  const price = h('input', { type: 'number', class: 'f-input ml-num', id: `pr-${drug.id}`, min: '0', step: '1', inputmode: 'decimal', value: st.price, 'data-testid': `price-${drug.id}` });
  const cost = h('p', { class: 'ml-cost', 'data-testid': `cost-${drug.id}` });
  const showCost = () => {
    const v = parseFloat(price.value);
    st.price = price.value;
    cost.textContent = buy != null && v > 0 ? t('cost', { n: Math.round(v * buy).toLocaleString(isEn() ? 'en' : 'zh-TW') }) : '';
  };
  price.addEventListener('input', showCost);
  showCost();

  card.append(...[
    h('p', { class: 'ml-reg', text: regimenText(drug) }),
    h('p', { class: 'ml-tab', text: isEn() ? drug.tabletEn : drug.tabletZh }),
    h('div', { class: 'ml-calc' },
      h('div', { class: 'f-field' }, h('label', { for: leadSel.id, text: t('lead') }), leadSel),
      h('dl', { class: 'ml-dl' },
        h('div', {}, h('dt', { text: t('per_dose') }), h('dd', { 'data-testid': `dose-${drug.id}`, text: doseText(drug, dose) })),
        h('div', {}, h('dt', { text: t('first') }), h('dd', { 'data-testid': `first-${drug.id}`, text: fmtDate(sch.first) })),
        h('div', {}, h('dt', { text: t('last') }), h('dd', { 'data-testid': `last-${drug.id}`, text: fmtDate(sch.last) })),
        h('div', {}, h('dt', { text: t('doses') }), h('dd', { 'data-testid': `doses-${drug.id}`, text: t('doses_n', { n: sch.doses, f: t(drug.freq === 'weekly' ? 'freq_weekly' : 'freq_daily') }) })),
        h('div', { class: 'ml-buy' }, h('dt', { text: t('buy') }), h('dd', { 'data-testid': `buy-${drug.id}`, text: buy != null ? t('buy_n', { n: buy }) : t('buy_doctor') })))),
    dose.note ? h('p', { class: 'ml-note ml-dose-note', text: t(dose.note) }) : null,
    timeline(win, sch, drug),
    buy != null ? h('div', { class: 'ml-price' },
      h('div', { class: 'f-field' }, h('label', { for: price.id, text: t('price') }), price), cost) : null,
    calendarBlock(drug, sch, dose, win)].filter(Boolean));
  return card;
}

function groupNotes(win, legs) {
  const p = state.person;
  const want = [];
  if (p.age < 12) want.push('infants');
  if (p.pregnant !== 'no') want.push('pregnancy');
  if (p.hiv) want.push('immuno');
  if (win.days >= 180) want.push('longstay');
  const blocks = [];
  for (const g of want) {
    const seen = new Set();
    const lines = [];
    for (const l of legs) {
      for (const ln of l.entry?.groups?.[g] || []) {
        if (!seen.has(ln.t)) { seen.add(ln.t); lines.push(ln); }
      }
    }
    if (lines.length) blocks.push(h('div', { class: 'ml-gn' }, h('p', { class: 'ml-gn-h', text: t(`g_${g}`) }), zhLabel(), linesEl(lines)));
  }
  return blocks.length ? h('section', { class: 'ml-gns', 'aria-label': t('gn_h') }, h('h3', { text: t('gn_h') }), blocks) : null;
}

function renderResult() {
  readPerson();
  const box = $('.ml-res');
  if (!state.data) return;
  const legs = calcLegs();
  const bad = legs.find((l) => l.arrive && l.depart && dayMs(l.depart) < dayMs(l.arrive));
  const v = bad ? 'incomplete' : verdict(legs);
  const kids = [];
  kids.push(h('div', { class: `ml-verdict ml-v-${v}`, 'data-testid': 'verdict', 'data-verdict': v },
    h('p', { class: 'ml-v-h', text: bad ? t('v_bad_dates') : t(`v_${v}`) }),
    v !== 'incomplete' ? h('p', { class: 'ml-v-s', text: t(`v_${v}_s`) }) : null));
  if (v === 'need') {
    const win = riskWindow(legs);
    kids.push(h('p', { class: 'ml-win', 'data-testid': 'window' },
      t('window', { a: fmtDate(win.start), b: fmtDate(win.end), n: win.days }),
      win.legs.length > 1 ? [' ', h('span', { class: 'muted', text: t('window_note') })] : null));
    kids.push(h('div', { class: 'ml-go' },
      h('p', {}, h('b', { text: t('go_h') }), ' ', t('go_s')),
      h('a', { class: 'btn btn-go', href: 'trip.html#clinics', text: t('go_btn') })));
    if (win.mefResistant) kids.push(h('p', { class: 'ml-warn', text: t('mef_resistant_note') }));
    if (!(state.person.age >= 0) || (!(state.person.weight > 0) && state.person.age < 18)) {
      kids.push(h('p', { class: 'ml-warn', text: t('need_person') }));
    }
    const order = { ok: 0, caution: 1, covered: 2, no: 3 };
    const cards = DRUGS.map((d) => ({ d, s: assess(d, state.person, win).status }))
      .sort((a, b) => order[a.s] - order[b.s]).map(({ d }) => drugCard(d, win));
    if (DRUGS.every((d) => assess(d, state.person, win).status === 'no')) kids.push(h('p', { class: 'ml-warn', text: t('none_suitable') }));
    kids.push(h('div', { class: 'ml-drugs' }, cards));
    kids.push(groupNotes(win, legs));
    kids.push(h('div', { class: 'ml-general' },
      h('h3', { text: t('general_h') }),
      h('ul', {}, ['gen_1', 'gen_2', 'gen_3', 'gen_4', 'gen_5'].map((k) => h('li', { text: t(k) })))));
    kids.push(h('div', { class: 'ml-actions' },
      h('button', { type: 'button', class: 'btn', 'data-testid': 'print', onclick: () => window.print(), text: t('print') })));
  }
  kids.push(h('p', { class: 'ml-src' }, t('src', { d: SOURCE_DATE }), ' ',
    h('a', { href: SOURCE_URL, target: '_blank', rel: 'noopener noreferrer', text: t('src_link') })));
  box.replaceChildren(...kids.filter(Boolean));
}

// ---------------------------------------------------------------- page chrome
function applyStatic() {
  root.lang = lang;
  document.title = t('doc_title');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.dataset.i18nAttr.split(';').forEach((pair) => {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
  const dark = root.dataset.theme === 'dark';
  const tb = $('.theme-toggle');
  tb.querySelector('.theme-text').textContent = dark ? t('theme_to_light') : t('theme_to_dark');
  tb.setAttribute('aria-label', dark ? t('theme_to_light') : t('theme_to_dark'));
  $('.lang-toggle').setAttribute('aria-label', t('lang_toggle_label'));
}
$('.theme-toggle').addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  storageSet(THEME_KEY, root.dataset.theme);
  applyStatic();
});
const textSize = bindTextSize($('[data-testid="textsize-toggle"]'), { t });
$('.lang-toggle').addEventListener('click', () => {
  lang = isEn() ? 'zh-Hant' : 'en';
  storageSet(LANG_KEY, lang);
  syncUrlLang(lang);
  applyStatic();
  textSize.refresh();
  renderLegs();
  renderResult();
  map?.relabel();
  renderMapSource();
});
$('.ml-add').addEventListener('click', () => {
  const prev = state.legs.at(-1);
  const leg = newLeg();
  if (prev?.depart) leg.arrive = prev.depart;
  state.legs.push(leg);
  renderLegs();
  $(`#c-${leg.id}`)?.focus();
  renderResult();
});
// 'input' only: a 'change' on blur would rebuild the result cards under the pointer as you click into them
$('#who').addEventListener('input', renderResult);

async function main() {
  applyStatic();
  textSize.refresh();
  root.classList.remove('i18n-pending');
  state.legs = [newLeg()];
  try {
    const r = await fetch('data/malaria.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.data = await r.json();
  } catch (e) {
    console.warn('malaria: data unavailable', e);
    $('.ml-res').replaceChildren(h('p', { class: 'ml-warn', text: t('data_failed') }));
  }
  // ?c=KE preselects a destination (for a later link from trip.html)
  const pre = new URLSearchParams(location.search).get('c');
  if (pre && state.data?.countries?.[pre.toUpperCase()]) state.legs[0].iso = pre.toUpperCase();
  renderLegs();
  renderResult();
  renderMapSource();
  await initMap();
  document.body.dataset.ready = '1';
}
main();
