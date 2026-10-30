// trip.html world-city weather: Central Weather Administration (CWA) open data F-C0032-007, 80 cities × 7 days.
// Section #weather (region tabs, text filter, °C/°F) plus the "local weather" block of the destination card.
// DOM is built with textContent / SVG attributes only; icons are <use> references into the sprite in trip.html.
import { h, extLink } from './trip-dom.js';
import { t, isEn, nameOf, fmtStamp, fmtDay } from './trip-i18n.js';
import { getJSON, safeHref, normKey } from './trip-data.js';
import { clean, parseDay, storageGet, storageSet } from './util.js';

const UNIT_KEY = 'safetravel.trip.unit';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = new Set(['sun', 'partly', 'cloud', 'overcast', 'rain', 'showers', 'thunder', 'snow', 'sleet', 'fog']);
const WET = new Set(['rain', 'showers', 'thunder', 'sleet']);
const ISO_RE = /^[A-Z]{2}$/;
const DEFAULT_URL = 'https://opendata.cwa.gov.tw/dataset/forecast/F-C0032-007';

// ---------------- data ----------------
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

/** Validate weather.json into the shape the UI relies on (bad rows are dropped, never trusted). */
function normalize(raw) {
  const src = obj(raw?.source) || {};
  const regions = (Array.isArray(raw?.regions) ? raw.regions : []).map(obj).filter(Boolean)
    .map((r) => ({ id: String(r.id ?? ''), zh: clean(r.zh), en: clean(r.en) }))
    .filter((r) => /^[\w-]{1,32}$/.test(r.id));
  const order = new Map(regions.map((r, i) => [r.id, i]));
  const cities = [];
  (Array.isArray(raw?.cities) ? raw.cities : []).forEach((c, idx) => {
    if (!obj(c) || !Array.isArray(c.days)) return;
    const days = c.days.map(obj).filter(Boolean).map((d) => {
      let max = num(d.max);
      let min = num(d.min);
      if (max != null && min != null && min > max) [max, min] = [min, max];
      return {
        date: fmtDay(d.date), icon: ICONS.has(d.icon) ? d.icon : 'cloud', zh: clean(d.wx_zh), en: clean(d.wx_en), max, min,
      };
    }).filter((d) => d.date);
    const nameZh = clean(c.name_zh);
    const nameEn = clean(c.name_en);
    if (!days.length || !(nameZh || nameEn)) return;
    const iso = ISO_RE.test(String(c.iso ?? '')) ? c.iso : null;
    const region = order.has(c.region) ? c.region : '';
    cities.push({
      id: String(c.id ?? idx), nameZh: nameZh || nameEn, nameEn: nameEn || nameZh, iso, region, days, idx,
    });
  });
  if (!cities.length) throw new Error('weather.json has no usable cities');
  // CWA's region order, then CWA's city order
  cities.sort((a, b) => (order.get(a.region) ?? 99) - (order.get(b.region) ?? 99) || a.idx - b.idx);
  if (cities.some((c) => !c.region)) regions.push({ id: '', zh: '其他', en: 'Other' });

  const temps = cities.flatMap((c) => c.days.flatMap((d) => [d.max, d.min])).filter((v) => v != null);
  let lo = temps.length ? Math.floor(Math.min(...temps) / 5) * 5 : 0;
  let hi = temps.length ? Math.ceil(Math.max(...temps) / 5) * 5 : 30;
  if (hi - lo < 10) { lo -= 5; hi += 5; }
  return {
    issued: typeof src.issued === 'string' ? src.issued : '',
    url: safeHref(src.url) || DEFAULT_URL,
    regions, cities, scale: { lo, hi },
  };
}

let dataPromise = null;
/** weather.json, fetched once per page (retried after a failure). */
export function loadWeather() {
  dataPromise ||= getJSON('data/weather.json').then(normalize).catch((e) => { dataPromise = null; throw e; });
  return dataPromise;
}

// ---------------- formatting ----------------
let unit = storageGet(UNIT_KEY) === 'F' ? 'F' : 'C';
const conv = (c) => (c == null ? null : unit === 'F' ? Math.round((c * 9) / 5 + 32) : c);
const minus = (v) => String(v).replace('-', '\u2212'); // typographic minus for sub-zero values
const deg = (c) => (c == null ? '–' : `${minus(conv(c))}°`);
const cityName = (c) => (isEn() ? c.nameEn : c.nameZh);
const cityAlt = (c) => (isEn() ? c.nameZh : c.nameEn);
const phrase = (d) => (isEn() ? d.en || d.zh : d.zh || d.en);
const weekday = (date) => { const x = parseDay(date); return x ? t('wx_wd', { i: x.getUTCDay() }) : ''; };
const isWeekend = (date) => { const x = parseDay(date); return !!x && (x.getUTCDay() === 0 || x.getUTCDay() === 6); };
let mdFmt = null;
function monthDay(date) {
  const x = parseDay(date);
  if (!x) return date;
  if (!isEn()) return `${x.getUTCMonth() + 1}/${x.getUTCDate()}`;
  mdFmt ||= new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return mdFmt.format(x);
}
const longDay = (date) => (isEn() ? `${weekday(date)} ${monthDay(date)}` : `${monthDay(date)}（${weekday(date)}）`);

/** Temperature with a screen-reader prefix (High / Low) and unit. */
function temp(c, kind, cls) {
  if (c == null) {
    return h('span', { class: `${cls} wx-na` },
      h('span', { 'aria-hidden': 'true', text: '–' }), h('span', { class: 'sr-only', text: `${t(`wx_${kind}`)} ${t('wx_na')}` }));
  }
  return h('span', { class: cls },
    h('span', { class: 'sr-only', text: `${t(`wx_${kind}`)} ` }), deg(c), h('span', { class: 'sr-only', text: unit }));
}

function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  el.append(...kids);
  return el;
}

/** Weather icon from the sprite; `label` gives it an accessible name, otherwise it is decorative. */
function icon(name, label, cls = '') {
  return svg('svg', {
    class: `wxi wxi-${name}${cls ? ` ${cls}` : ''}`, viewBox: '0 0 32 32', focusable: 'false',
    role: label ? 'img' : null, 'aria-label': label || null, 'aria-hidden': label ? null : 'true',
  }, svg('use', { href: `#wx-${name}` }));
}

/**
 * Vertical min–max bar on the shared scale. User units are °C with y = -temperature, so the
 * #wx-ramp gradient (userSpaceOnUse) colours every bar by absolute temperature.
 */
function rangeBar(d, { lo, hi }) {
  const bar = svg('svg', {
    class: 'wx-bar', viewBox: `0 ${-hi} 10 ${hi - lo}`, preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false',
  }, svg('line', { class: 'wx-track', x1: 5, x2: 5, y1: -hi, y2: -lo }));
  const top = d.max ?? d.min;
  const bot = d.min ?? d.max;
  if (top != null) bar.append(svg('line', { class: 'wx-rng', x1: 5, x2: 5, y1: -top, y2: -bot, stroke: 'url(#wx-ramp)' }));
  return bar;
}

/** Horizontal swatch of the same ramp for the scale legend. */
function rampSwatch({ lo, hi }) {
  return svg('svg', {
    class: 'wx-swatch', viewBox: `${lo} -2 ${hi - lo} 4`, preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false',
  }, svg('line', { x1: 0, x2: 0, y1: -lo, y2: -hi, transform: 'rotate(90)', stroke: 'url(#wx-ramp)' }));
}

function issuedText(data) {
  const d = fmtStamp(data.issued);
  return d ? t('wx_issued', { d }) : t('wx_issued_nodate');
}

// ---------------- city card ----------------
function dayStrip(c, scale) {
  return h('ol', { class: 'wx-days', 'aria-label': t('wx_days_label', { city: cityName(c) }) }, c.days.map((d) => h('li', {
    class: `wx-day${isWeekend(d.date) ? ' wx-we' : ''}${WET.has(d.icon) ? ' wx-wet' : ''}`,
  },
  h('span', { class: 'wx-dw', text: weekday(d.date) }),
  h('time', { class: 'wx-dd', datetime: d.date, text: monthDay(d.date) }),
  icon(d.icon, phrase(d), 'wx-di'),
  temp(d.max, 'hi', 'wx-dhi'),
  rangeBar(d, scale),
  temp(d.min, 'lo', 'wx-dlo'))));
}

function weekSummary(c) {
  const maxes = c.days.map((d) => d.max).filter((v) => v != null);
  const mins = c.days.map((d) => d.min).filter((v) => v != null);
  const wet = c.days.filter((d) => WET.has(d.icon)).length;
  const items = [];
  if (maxes.length && mins.length) {
    items.push(h('span', { class: 'wx-sum-range' },
      h('span', { class: 'wx-sum-k', text: t('wx_week') }), ' ',
      t('wx_range', { lo: deg(Math.min(...mins)), hi: deg(Math.max(...maxes)) }),
      h('span', { class: 'sr-only', text: unit })));
  }
  items.push(h('span', { class: `wx-sum-wet${wet ? '' : ' dry'}`, text: wet ? t('wx_wet', { n: wet }) : t('wx_dry') }));
  return h('p', { class: 'wx-sum' }, items);
}

function cityCard(c, data, model) {
  const dest = c.iso ? model?.dests.get(c.iso) : null;
  const country = dest ? nameOf(dest) : '';
  const first = c.days[0];
  const name = cityName(c);
  const title = dest
    ? h('button', { type: 'button', class: 'wx-open', dataset: { iso: dest.iso } },
      name, h('span', { class: 'sr-only', text: t('wx_open', { country }) }))
    : h('span', { text: name });
  const ctry = h('p', { class: 'wx-ctry' },
    country && country !== name ? h('span', { class: 'wx-ctry-n', text: country }) : null,
    c.iso ? h('span', { class: 'wx-iso', text: c.iso }) : h('span', { class: 'wx-nomap', text: t('wx_no_card') }));
  return h('li', {
    class: `wx-city${dest ? ' is-link' : ''}`, 'data-testid': 'wx-city', dataset: { iso: c.iso || '', region: c.region },
  },
  h('div', { class: 'wx-top' },
    h('div', { class: 'wx-names' },
      h('h4', { class: 'wx-name' }, title),
      h('p', { class: 'wx-alt', lang: isEn() ? 'zh-Hant' : 'en', text: cityAlt(c) }),
      ctry),
    h('div', { class: 'wx-now' },
      icon(first.icon, '', 'wx-now-i'),
      h('div', { class: 'wx-now-t' }, temp(first.max, 'hi', 'wx-now-hi'), temp(first.min, 'lo', 'wx-now-lo')))),
  h('p', { class: 'wx-now-wx' },
    h('time', { datetime: first.date, text: longDay(first.date) }),
    h('span', { class: 'wx-now-ph', text: phrase(first) })),
  weekSummary(c),
  dayStrip(c, data.scale));
}

// ---------------- section ----------------
export function createWeather({ root, onOpen, onSettled }) {
  const st = { region: 'all', q: '' };
  let data = null;
  let failed = false;
  let model = null;
  let cards = [];   // [{ el, city, keys }]
  let groups = [];  // [{ el, id }]
  let tabEls = [];
  const local = new Set(); // destination-card blocks to refresh on a unit change

  const tools = root.querySelector('.wx-tools');
  const tabsEl = root.querySelector('.wx-tabs');
  const input = root.querySelector('#wx-q');
  const countEl = root.querySelector('.wx-count');
  const scaleEl = root.querySelector('.wx-scale');
  const panel = root.querySelector('#wx-panel');
  const subEl = root.querySelector('.wx-sub');
  const unitBox = root.querySelector('.wx-unit');

  input.addEventListener('input', () => { st.q = input.value; apply(); });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && input.value) { input.value = ''; st.q = ''; apply(); } });
  unitBox.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-unit]');
    if (!b || b.dataset.unit === unit) return;
    unit = b.dataset.unit === 'F' ? 'F' : 'C';
    storageSet(UNIT_KEY, unit);
    render();
    for (const fill of local) fill();
  });
  panel.addEventListener('click', (ev) => {
    const b = ev.target.closest('.wx-open');
    if (b) onOpen(b.dataset.iso);
  });

  function setRegion(id, focus = false) {
    st.region = id;
    for (const b of tabEls) {
      const on = b.dataset.region === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on) {
        panel.setAttribute('aria-labelledby', b.id);
        if (focus) b.focus();
      }
    }
    apply();
  }

  function buildTabs() {
    const items = [{ id: 'all', label: t('wx_all') }, ...data.regions.map((r) => ({ id: r.id, label: isEn() ? r.en || r.zh : r.zh || r.en }))];
    tabEls = items.map((r) => h('button', {
      type: 'button', role: 'tab', class: 'tab wx-tab', id: `wx-tab-${r.id || 'other'}`, 'aria-controls': 'wx-panel',
      'aria-selected': 'false', tabindex: '-1', dataset: { region: r.id }, 'data-testid': `wx-tab-${r.id || 'other'}`,
    }, h('span', { text: r.label }), h('span', { class: 'wx-tab-n', text: '' })));
    tabsEl.replaceChildren(...tabEls);
    tabEls.forEach((b, i) => {
      b.addEventListener('click', () => setRegion(b.dataset.region));
      b.addEventListener('keydown', (ev) => {
        const n = tabEls.length;
        const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[ev.key];
        if (to == null) return;
        ev.preventDefault();
        setRegion(tabEls[(to + n) % n].dataset.region, true);
      });
    });
    if (!tabEls.some((b) => b.dataset.region === st.region)) st.region = 'all';
  }

  function buildCards() {
    cards = [];
    groups = [];
    const nodes = data.regions.map((r) => {
      const ul = h('ul', { class: 'wx-grid' });
      const list = data.cities.filter((c) => c.region === r.id);
      for (const c of list) {
        const dest = c.iso ? model?.dests.get(c.iso) : null;
        const keys = [c.nameZh, c.nameEn, c.iso, dest?.nameZh, dest?.nameEn, ...(dest?.keys || [])].filter(Boolean).map(normKey);
        const el = cityCard(c, data, model);
        cards.push({ el, city: c, keys });
        ul.append(el);
      }
      const label = isEn() ? r.en || r.zh : r.zh || r.en;
      const n = h('span', { class: 'wx-group-n' });
      const el = h('div', { class: 'wx-group', dataset: { region: r.id } },
        h('h3', { class: 'wx-group-h' }, h('span', { text: label }), n), ul);
      groups.push({ el, id: r.id, n });
      return list.length ? el : null;
    });
    panel.replaceChildren(...nodes.filter(Boolean), h('p', { class: 'wx-msg wx-empty muted', text: t('wx_empty'), hidden: true }));
  }

  function apply() {
    if (!data) return;
    const q = normKey(st.q);
    const perRegion = new Map();
    let shown = 0;
    let matched = 0;
    for (const c of cards) {
      const textOk = !q || c.keys.some((k) => k.includes(q));
      if (textOk) { matched += 1; perRegion.set(c.city.region, (perRegion.get(c.city.region) || 0) + 1); }
      const ok = textOk && (st.region === 'all' || c.city.region === st.region);
      c.el.hidden = !ok;
      if (ok) shown += 1;
    }
    for (const g of groups) {
      const n = perRegion.get(g.id) || 0;
      g.el.hidden = !n || (st.region !== 'all' && st.region !== g.id);
      g.n.textContent = String(n);
    }
    for (const b of tabEls) {
      const id = b.dataset.region;
      b.querySelector('.wx-tab-n').textContent = String(id === 'all' ? matched : perRegion.get(id) || 0);
    }
    panel.dataset.all = st.region === 'all' ? '1' : '0';
    panel.querySelector('.wx-empty').hidden = shown > 0;
    countEl.textContent = t('wx_count', { n: shown, total: cards.length });
  }

  function renderUnit() {
    unitBox.querySelectorAll('[data-unit]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.unit === unit)));
  }

  function render() {
    renderUnit();
    if (failed) {
      tools.hidden = true;
      unitBox.hidden = true;
      countEl.textContent = '';
      scaleEl.replaceChildren();
      subEl.textContent = '';
      panel.removeAttribute('aria-labelledby');
      panel.removeAttribute('role');
      panel.replaceChildren(h('p', { class: 'notice wx-fail', 'data-testid': 'wx-failed' },
        h('span', { text: t('wx_failed') }), ' ', extLink(DEFAULT_URL, t('wx_failed_link'))));
      return;
    }
    if (!data) return; // still loading: the static "loading" line is translated by applyStatic()
    tools.hidden = false;
    unitBox.hidden = false;
    subEl.replaceChildren(
      h('span', { text: t('wx_lede', { n: data.cities.length }) }), ' ',
      h('span', { class: 'wx-prov' }, h('b', { text: issuedText(data) }), h('span', { text: ` · ${t('wx_tz_note')}` })));
    const { lo, hi } = data.scale;
    scaleEl.replaceChildren(h('span', { class: 'wx-scale-v', text: deg(lo) }), rampSwatch(data.scale),
      h('span', { class: 'wx-scale-v', text: deg(hi) }), h('span', { text: t('wx_scale', { lo: deg(lo), hi: deg(hi) }) }));
    const foot = document.querySelector('.foot-cwa');
    if (foot) foot.href = data.url;
    buildTabs();
    buildCards();
    setRegion(st.region);
    input.value = st.q;
  }

  /** Destination-card block for `iso`: hidden placeholder, filled when weather.json is in (nothing if no city). */
  function localSection(iso) {
    const sec = h('section', { class: 'wx-local', 'aria-labelledby': 'wxl-h', hidden: true, 'data-testid': 'card-weather' });
    const fill = () => {
      const cities = data ? data.cities.filter((c) => c.iso === iso) : [];
      if (!cities.length) { sec.hidden = true; sec.replaceChildren(); return; }
      sec.replaceChildren(...localBlock(iso, cities));
      sec.hidden = false;
    };
    local.clear(); // one card is open at a time
    local.add(fill);
    if (data) fill(); // otherwise attach() fills it once weather.json is in
    return sec;
  }

  function localBlock(iso, cities) {
    const dest = model?.dests.get(iso);
    const days = cities[0].days.map((d) => d.date);
    const table = h('table', { class: 'wxl' },
      h('caption', { class: 'sr-only', text: t('card_wx_caption', { country: dest ? nameOf(dest) : iso }) }),
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', class: 'wxl-c', text: t('card_wx_city') }),
        days.map((date) => h('th', { scope: 'col', class: isWeekend(date) ? 'wx-we' : null },
          h('span', { class: 'wx-dw', text: weekday(date) }), h('time', { class: 'wx-dd', datetime: date, text: monthDay(date) }))))),
      h('tbody', {}, cities.map((c) => h('tr', {},
        h('th', { scope: 'row', class: 'wxl-c' },
          h('span', { class: 'wxl-n', text: cityName(c) }), h('span', { class: 'wxl-a', lang: isEn() ? 'zh-Hant' : 'en', text: cityAlt(c) })),
        days.map((date) => {
          const d = c.days.find((x) => x.date === date);
          if (!d) return h('td', { class: 'wx-na', text: '–' });
          return h('td', {},
            icon(d.icon, phrase(d), 'wxl-i'),
            h('span', { class: 'wxl-p', 'aria-hidden': 'true', text: phrase(d) }),
            h('span', { class: 'wxl-t' }, temp(d.max, 'hi', 'wx-dhi'), h('span', { class: 'wxl-sl', 'aria-hidden': 'true', text: '/' }), temp(d.min, 'lo', 'wx-dlo')));
        })))));
    return [
      h('div', { class: 'epi-head' },
        h('h3', { id: 'wxl-h', text: t('card_wx_h') }),
        h('p', { class: 'muted' }, h('span', { text: issuedText(data) }), h('span', { text: ` · ${t('wx_tz_note')}` }))),
      h('div', { class: 'wxl-wrap' }, table),
      h('p', { class: 'wxl-src' }, extLink(data.url, t('wx_failed_link')), h('span', { class: 'muted', text: ` · °${unit}` })),
    ];
  }

  return {
    setModel(m) { model = m; },
    render,
    localSection,
    /** Resolve the shared weather.json promise into the section. */
    attach(promise) {
      return promise.then((d) => { data = d; failed = false; }).catch((err) => {
        console.warn('trip: weather.json unavailable', err);
        failed = true;
      }).then(() => {
        render();
        for (const fill of local) fill();
        onSettled?.();
      });
    },
    /** Header stamp: null while loading, '' when unavailable, else the issue time. */
    stamp() { return data ? fmtStamp(data.issued) : failed ? '' : null; },
  };
}
