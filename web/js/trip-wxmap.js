// trip.html map, "weather" tab: CWA world-city forecasts as markers on the existing world map.
// Markers live in the map's untransformed overlay group and are re-projected through the current zoom
// transform on every view change, so they pan / zoom with the map while keeping their size on screen.
// A greedy screen-space pass gives each city a full marker (icon + max temperature) where there is room
// and a temperature-coloured dot elsewhere; zooming in re-runs it and reveals more full markers.
import { h } from './trip-dom.js';
import { t, nameOf } from './trip-i18n.js';
import { wx } from './trip-weather.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PLAY_MS = 1600;
// placed first when space is short (well-known destinations for Taiwanese travellers); then CWA's order
const MAJOR = [
  'Tokyo', 'Seoul', 'Hong Kong', 'Bangkok', 'Singapore', 'Shanghai', 'Beijing', 'Manila', 'Ho Chi Minh City', 'Kuala Lumpur',
  'Jakarta', 'Sydney', 'Auckland', 'New Delhi', 'Kathmandu', 'Moscow', 'Istanbul', 'London', 'Paris', 'Rome', 'Frankfurt', 'Madrid',
  'Cairo', 'Johannesburg', 'New York', 'Los Angeles', 'San Francisco', 'Vancouver', 'Toronto', 'Honolulu', 'Guam', 'Mexico City',
  'Rio de Janeiro', 'Buenos Aires', 'Lima', 'Santiago', 'Osaka', 'Guangzhou', 'Vladivostok', 'Perth', 'Stockholm', 'Athens',
];
// temperature buckets (°C) → CSS classes .wxk-* that mix the same ramp colours as the cards' bars
const BUCKETS = [-10, -5, 0, 5, 10, 14, 17, 20, 24, 27, 30, 34, 38];
const PILL_H = 22;
const GAP = 6;      // dot centre → pill edge
const DOT_PAD = 6;  // half-size of the box a dot keeps clear

export function tempClass(c) {
  if (c == null) return 'wxk-na';
  let best = BUCKETS[0];
  for (const b of BUCKETS) if (Math.abs(c - b) < Math.abs(c - best)) best = b;
  return `wxk-${best < 0 ? `m${-best}` : best}`;
}

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  return el;
}

// rough text widths (no layout reads): temperature 12.5px bold tabular, city name 12px semibold
const textWidth = (s) => [...s].reduce((w, ch) => w + (ch === '°' ? 5 : ch === '–' ? 7 : 7.4), 0);
const nameWidth = (s) => [...s].reduce((w, ch) => w
  + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 12.4 : /[A-Z]/.test(ch) ? 8.8 : /[\s.,']/.test(ch) ? 3.8 : /[iljrft]/.test(ch) ? 4.6 : 7.4), 0);

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function createWxMap({ map, box, svgEl, tipEl, barEl, onOpen }) {
  const st = { active: false, day: 0, timer: 0, pinned: null, lastPointer: 'mouse', focus: 0 };
  let data = null;
  let model = null;
  let tipM = null;  // marker whose forecast the shared tooltip shows
  let markers = []; // in keyboard order
  let prio = [];    // in placement order

  const layer = svg('g', { class: 'wxm' });
  map.overlay.append(layer);
  map.onView(() => layout());

  const daysEl = barEl.querySelector('.wxm-days');
  const playBtn = barEl.querySelector('.wxm-play');

  // ---------------- markers ----------------
  function build() {
    layer.replaceChildren();
    markers = [];
    if (!data || !model) return;
    const regionIdx = new Map(data.regions.map((r, i) => [r.id, i]));
    const fromLeft = (lon) => (((lon - 155 + 540) % 360) + 360) % 360; // the map is centred on 155°E
    const cities = data.cities.filter((c) => c.lat != null && c.lon != null);
    cities.sort((a, b) => (regionIdx.get(a.region) ?? 99) - (regionIdx.get(b.region) ?? 99) || fromLeft(a.lon) - fromLeft(b.lon));
    for (const c of cities) {
      const dest = c.iso ? model.dests.get(c.iso) : null;
      const bg = svg('rect', { class: 'wxm-bg', height: PILL_H, rx: PILL_H / 2 });
      const use = svg('use', { class: 'wxm-i', x: 4, y: 2, width: 18, height: 18 });
      const text = svg('text', { class: 'wxm-t', x: 24, y: 15.5 });
      const name = svg('text', { class: 'wxm-n', y: 15 });
      const pill = svg('g', { class: 'wxm-pill' });
      pill.append(bg, use, text, name);
      const el = svg('g', {
        class: 'wxm-m', tabindex: '-1', role: dest ? 'button' : 'img', 'data-testid': 'wx-marker', 'data-city': c.id, 'data-iso': c.iso || null,
      });
      el.append(pill, svg('circle', { class: 'wxm-dot', r: 4.5 }));
      layer.append(el);
      markers.push({
        city: c, dest, el, pill, bg, use, text, name, wS: 0, wL: 0, full: false, named: false, px: 0, py: 0, ox: 0, oy: 0,
      });
    }
    const rank = (m) => { const i = MAJOR.indexOf(m.city.nameEn); return i < 0 ? MAJOR.length + m.city.idx : i; };
    prio = [...markers].sort((a, b) => rank(a) - rank(b));
    st.focus = Math.min(st.focus, Math.max(0, markers.length - 1));
    markers.forEach((m, i) => { m.i = i; m.el.tabIndex = i === st.focus ? 0 : -1; });
    paint();
  }

  /** Day-dependent content: icon, text, tint and accessible name. */
  function paint() {
    for (const m of markers) {
      const d = m.city.days[st.day] || m.city.days[0];
      const label = wx.deg(d.max ?? d.min);
      m.text.textContent = label;
      m.use.setAttribute('href', `#wx-${d.icon}`);
      const tw = textWidth(label);
      const nm = wx.cityName(m.city);
      m.name.textContent = nm;
      m.name.setAttribute('x', Math.round(24 + tw + 5));
      m.wS = Math.round(24 + tw + 8);
      m.wL = Math.round(24 + tw + 5 + nameWidth(nm) + 9);
      m.el.setAttribute('class', `wxm-m ${tempClass(d.max ?? d.min)}${m.full ? ' is-full' : ''}`);
      const country = m.dest ? nameOf(m.dest) : '';
      m.el.setAttribute('aria-label', t('wxm_marker', {
        city: wx.cityName(m.city), country, wx: wx.phrase(d), hi: wx.deg(d.max), lo: wx.deg(d.min),
      }));
    }
    layout();
    if (st.pinned || (tipEl.dataset.owner === 'wx' && !tipEl.hidden)) {
      const m = markers.find((x) => x.el === document.activeElement) || st.pinned;
      if (m) showTip(m);
    }
  }

  /** Project, then greedily place full markers in priority order; the rest stay dots. */
  function layout() {
    if (!st.active || !markers.length) return;
    const { width, height } = map.size();
    const pts = [];
    for (const m of markers) {
      const p = map.project(m.city.lon, m.city.lat);
      m.vis = !!p && p[0] > -10 && p[0] < width + 10 && p[1] > -10 && p[1] < height + 10;
      if (p) [m.px, m.py] = p;
      if (m.vis) pts.push({ m, x: m.px - DOT_PAD, y: m.py - DOT_PAD, w: DOT_PAD * 2, h: DOT_PAD * 2 });
    }
    // pill positions around the dot: above, right, left, below
    const cands = (w) => [[-w / 2, -GAP - PILL_H], [GAP, -PILL_H / 2], [-GAP - w, -PILL_H / 2], [-w / 2, GAP]];
    const placed = []; // { m, r }
    const tryPlace = (m, w) => {
      for (const [ox, oy] of cands(w)) {
        const r = { x: m.px + ox - 1, y: m.py + oy - 1, w: w + 2, h: PILL_H + 2 };
        if (r.x < 0 || r.y < 0 || r.x + r.w > width || r.y + r.h > height) continue;
        if (placed.some((q) => q.m !== m && overlaps(r, q.r))) continue;
        if (pts.some((q) => q.m !== m && overlaps(r, q))) continue;
        return { r, ox, oy };
      }
      return null;
    };
    // pass 1: as many short markers (icon + temperature) as fit, by priority
    for (const m of prio) {
      m.full = false;
      m.named = false;
      const hit = m.vis ? tryPlace(m, m.wS) : null;
      if (hit) {
        placed.push({ m, r: hit.r });
        Object.assign(m, { full: true, ox: hit.ox, oy: hit.oy });
      }
    }
    // pass 2: add the city name where the longer pill still fits
    for (const q of placed) {
      const hit = tryPlace(q.m, q.m.wL);
      if (hit) {
        q.r = hit.r;
        Object.assign(q.m, { named: true, ox: hit.ox, oy: hit.oy });
      }
    }
    // dots show their named pill on hover / focus, above the dot (below near the top edge)
    for (const m of markers) {
      if (m.full) continue;
      m.named = true;
      [m.ox, m.oy] = cands(m.wL)[m.py - PILL_H - GAP < 0 ? 3 : 0];
    }
    for (const m of markers) {
      m.el.setAttribute('transform', `translate(${m.px.toFixed(1)} ${m.py.toFixed(1)})`);
      m.pill.setAttribute('transform', `translate(${m.ox.toFixed(1)} ${m.oy.toFixed(1)})`);
      m.bg.setAttribute('width', m.named ? m.wL : m.wS);
      m.el.classList.toggle('is-full', m.full);
      m.el.classList.toggle('is-named', m.named);
      m.el.classList.toggle('is-off', !m.vis);
    }
    if (!tipEl.hidden && tipEl.dataset.owner === 'wx' && tipM) placeTip(tipM);
  }

  // ---------------- tooltip ----------------
  function showTip(m, touch = false) {
    const days = m.city.days;
    const sub = [wx.cityAlt(m.city), m.dest ? nameOf(m.dest) : ''].filter(Boolean).join(' · ');
    tipEl.replaceChildren(
      h('strong', { class: 'tip-name', text: wx.cityName(m.city) }),
      h('span', { class: 'tip-alt', text: sub }),
      h('ol', { class: 'wxt-days' }, days.map((d, i) => h('li', { class: `wxt-d${i === st.day ? ' is-sel' : ''}` },
        h('span', { class: 'wxt-dw', text: wx.weekday(d.date) }),
        wx.icon(d.icon, wx.phrase(d), 'wxt-i'),
        h('span', { class: 'wxt-hi', text: wx.deg(d.max) }),
        h('span', { class: 'wxt-lo', text: wx.deg(d.min) })))),
      h('span', { class: 'tip-hint', text: !m.dest ? t('wx_no_card') : touch ? t('wxm_tap_again') : t('tip_click') }),
    );
    tipEl.dataset.owner = 'wx';
    tipM = m;
    tipEl.hidden = false;
    for (const x of markers) x.el.classList.toggle('is-hot', x === m);
    placeTip(m);
  }
  function placeTip(m) {
    const br = box.getBoundingClientRect();
    const sr = svgEl.getBoundingClientRect();
    const k = sr.width / (map.size().width || 1);
    const x = sr.left - br.left + m.px * k;
    const y = sr.top - br.top + m.py * k;
    const tw = tipEl.offsetWidth;
    const th = tipEl.offsetHeight;
    let left = x + 14;
    if (left + tw > br.width - 4) left = Math.max(4, x - 14 - tw);
    let top = y + 14;
    if (top + th > br.height - 4 && y - 14 - th >= 4) top = y - 14 - th;
    tipEl.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`; // same technique as the country tooltip
  }
  function hideTip() {
    if (tipEl.dataset.owner !== 'wx') return;
    tipEl.hidden = true;
    tipM = null;
    delete tipEl.dataset.owner;
    st.pinned = null;
    for (const x of markers) x.el.classList.remove('is-hot');
  }

  // ---------------- interaction ----------------
  const markerOf = (ev) => {
    const el = ev.target?.closest?.('.wxm-m');
    return el ? markers.find((m) => m.el === el) : null;
  };
  function activate(m) {
    if (!m?.dest) return;
    hideTip();
    onOpen(m.dest.iso);
  }
  function focusMarker(i) {
    const n = markers.length;
    if (!n) return;
    st.focus = ((i % n) + n) % n;
    markers.forEach((m, j) => { m.el.tabIndex = j === st.focus ? 0 : -1; });
    markers[st.focus].el.focus();
  }

  layer.addEventListener('pointerdown', (ev) => { st.lastPointer = ev.pointerType || 'mouse'; });
  layer.addEventListener('pointerover', (ev) => {
    const m = markerOf(ev);
    if (!m || ev.pointerType === 'touch' || st.pinned) return;
    layer.append(m.el); // hovered marker on top (it is not focused, so re-appending is safe)
    showTip(m);
  });
  layer.addEventListener('pointerout', (ev) => {
    const m = markerOf(ev);
    if (!m || st.pinned || m.el.contains(ev.relatedTarget) || m.el === document.activeElement) return;
    hideTip();
  });
  layer.addEventListener('click', (ev) => {
    const m = markerOf(ev);
    if (!m) return;
    ev.stopPropagation();
    if (st.lastPointer === 'touch' && st.pinned !== m) { // first tap: show the forecast, second tap: open
      showTip(m, true);
      st.pinned = m;
      return;
    }
    activate(m);
  });
  svgEl.addEventListener('pointerdown', (ev) => { if (st.pinned && !markerOf(ev)) hideTip(); });
  layer.addEventListener('focusin', (ev) => {
    const m = markerOf(ev);
    if (!m) return;
    st.focus = m.i;
    markers.forEach((x) => { x.el.tabIndex = x === m ? 0 : -1; });
    showTip(m);
  });
  layer.addEventListener('focusout', (ev) => { if (!layer.contains(ev.relatedTarget) && !st.pinned) hideTip(); });
  layer.addEventListener('keydown', (ev) => {
    const m = markerOf(ev);
    if (!m) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    if (step) { ev.preventDefault(); stop(); focusMarker(m.i + step); }
    else if (ev.key === 'Home') { ev.preventDefault(); focusMarker(0); }
    else if (ev.key === 'End') { ev.preventDefault(); focusMarker(markers.length - 1); }
    else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(m); }
    else if (ev.key === 'Escape') { hideTip(); }
  });
  // any direct interaction with the map stops the day animation
  box.addEventListener('pointerdown', () => stop());
  box.addEventListener('wheel', () => stop(), { passive: true });

  // ---------------- day selector + play ----------------
  function buildDays() {
    const days = data?.cities[0]?.days || [];
    daysEl.replaceChildren(...days.map((d, i) => h('button', {
      type: 'button', class: `wxm-day${wx.isWeekend(d.date) ? ' wx-we' : ''}`, 'aria-pressed': String(i === st.day),
      'data-testid': `wxm-day-${i}`, dataset: { day: String(i) },
    }, h('span', { class: 'wx-dw', text: wx.weekday(d.date) }), h('time', { class: 'wx-dd', datetime: d.date, text: wx.monthDay(d.date) }))));
    playBtn.hidden = days.length < 2;
  }
  function setDay(i) {
    const n = data?.cities[0]?.days.length || 7;
    st.day = ((i % n) + n) % n;
    daysEl.querySelectorAll('[data-day]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.day === st.day)));
    paint();
  }
  function renderPlay() {
    const on = !!st.timer;
    playBtn.setAttribute('aria-pressed', String(on));
    playBtn.querySelector('.wxm-play-t').textContent = on ? t('wxm_stop') : t('wxm_play');
    playBtn.title = t('wxm_play_label');
  }
  function stop() {
    if (!st.timer) return;
    clearInterval(st.timer);
    st.timer = 0;
    renderPlay();
  }
  daysEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-day]');
    if (!b) return;
    stop();
    setDay(+b.dataset.day);
  });
  daysEl.addEventListener('keydown', (ev) => {
    const b = ev.target.closest('[data-day]');
    const step = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
    if (!b || !step) return;
    ev.preventDefault();
    stop();
    setDay(+b.dataset.day + step);
    daysEl.querySelector(`[data-day="${st.day}"]`)?.focus();
  });
  playBtn.addEventListener('click', () => {
    if (st.timer) { stop(); return; }
    setDay(st.day + 1);
    st.timer = setInterval(() => setDay(st.day + 1), PLAY_MS);
    renderPlay();
  });

  // ---------------- legend ----------------
  function legendItems() {
    if (!data) return [h('li', { class: 'lg-note', text: t('wxm_loading') })];
    const { lo, hi } = data.scale;
    const used = new Set(data.cities.flatMap((c) => c.days.map((d) => d.icon)));
    const icons = ['sun', 'partly', 'cloud', 'overcast', 'showers', 'rain', 'thunder', 'sleet', 'snow', 'fog'].filter((k) => used.has(k));
    return [
      h('li', { class: 'lg-scale' }, h('span', { class: 'lg-k', text: t('wxm_scale') }),
        h('span', { class: 'lg-n', text: wx.deg(lo) }), wx.rampSwatch(data.scale), h('span', { class: 'lg-n', text: wx.deg(hi) })),
      ...icons.map((k) => h('li', {}, wx.icon(k, '', 'lg-i'), h('span', { text: t(`wx_icon_${k}`) }))),
      h('li', { class: 'lg-note' }, h('span', { text: `${wx.issuedText(data)} · ${t('wx_tz_note')}` })),
    ];
  }

  return {
    setData(d, m) {
      data = d;
      model = m;
      buildDays();
      build();
      renderPlay();
    },
    setModel(m) { model = m; if (data) build(); },
    /** Language or unit changed: rebuild labels. */
    refresh() {
      if (!data) return;
      buildDays();
      renderPlay();
      paint();
    },
    setActive(on) {
      st.active = on;
      barEl.hidden = !on || !data;
      if (on) layout();
      else { stop(); hideTip(); }
    },
    legendItems,
    hideTip,
    hasData: () => !!data,
  };
}
