// Weather overlay for the main map: CWA world-city forecasts (data/weather.json, F-C0032-007) as markers on top of
// whichever colour layer is active. Loaded with a dynamic import() the first time the overlay is switched on, so a
// visitor who never turns it on fetches and builds nothing.
//
// Markers are HTML buttons in their own layer above the map, the flight canvas and the route-watch layer (below every
// HUD card), positioned in screen pixels from the projection and the current zoom transform: they pan / zoom with the
// map but keep their size. A greedy pass (wx-shared.js) shows a pill (icon + max temperature, + name when there is
// room) where it fits and a temperature-coloured dot elsewhere, avoiding the HUD cards, the docked arrivals board and
// the open panel. Zoom / pan / resize re-run it once per animation frame.
import { state, on } from './state.js';
import { t, isEn, countryName, fmtDateTime } from './i18n.js';
import { showTip, moveTip, hideTip } from './tooltip.js';
import { esc, parseDay } from './util.js';
import {
  normalizeWeather, tempClass, degree, declutter, cityRank, keyboardOrder, ICONS, WET,
} from './wx-shared.js';

const PLAY_MS = 1600;
const PILL_H = 22;
const SVG_NS = 'http://www.w3.org/2000/svg';
// HUD cards markers must not hide under (checked when visible)
const OBSTACLES = [
  '.hud', '#search', '.layer-row', '#level-chips', '#legend', '#flight-hud', '.zoom-ctrl', '#wx-bar',
  '#spotlight:not(.is-hidden)', '#panel:not([hidden])', '#arrivals:not([hidden])', '#watch-menu:not([hidden])',
  '#digest-status:not([hidden])', '.foot',
];

let loadP = null;
function loadWeather() {
  loadP ||= fetch('data/weather.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(`weather.json: HTTP ${r.status}`); return r.json(); })
    .then(normalizeWeather)
    .catch((e) => { loadP = null; throw e; });
  return loadP;
}

// ---------------------------------------------------------------- formatting
const deg = (c) => degree(c);
const phrase = (d) => (isEn() ? d.en || d.zh : d.zh || d.en);
const cityName = (c) => (isEn() ? c.nameEn : c.nameZh);
const cityAlt = (c) => (isEn() ? c.nameZh : c.nameEn);
const weekday = (date) => { const x = parseDay(date); return x ? t('wx_wd', { i: x.getUTCDay() }) : ''; };
const isWeekend = (date) => { const x = parseDay(date); return !!x && (x.getUTCDay() === 0 || x.getUTCDay() === 6); };
let mdFmt = null;
function monthDay(date) {
  const x = parseDay(date);
  if (!x) return '';
  if (!isEn()) return `${x.getUTCMonth() + 1}/${x.getUTCDate()}`;
  mdFmt ||= new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return mdFmt.format(x);
}
const safeIcon = (name) => (ICONS.includes(name) ? name : 'cloud');
/** Sprite icon as markup (name from a fixed list; label escaped). */
function iconHtml(name, label = '', cls = 'wxi') {
  const a = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
  return `<svg class="${cls}" viewBox="0 0 32 32" focusable="false" ${a}><use href="#wx-${safeIcon(name)}"/></svg>`;
}
const issuedText = (d) => {
  const when = d?.issued ? fmtDateTime(d.issued) : '';
  return when && when !== '—' ? t('wx_issued', { d: when }) : t('wx_issued', { d: '' }).trim();
};

/** Legend block (hud.js): only while the overlay is on. */
export function legendHtml() {
  const w = state.weather;
  if (!w?.on) return { block: '', mini: '' };
  if (w.status !== 'ready' || !w.data) {
    const msg = w.status === 'error' ? t('wx_error') : t('wx_loading');
    return { block: `<div class="legend-wx"><h3 class="legend-title">${esc(t('wx_legend_title'))}</h3><p class="legend-note">${esc(msg)}</p></div>`, mini: '' };
  }
  const { lo, hi } = w.data.scale;
  const used = new Set(w.data.cities.flatMap((c) => c.days.map((d) => d.icon)));
  const icons = ICONS.filter((k) => used.has(k));
  const ramp = `<span class="lg-wx-v mono">${esc(deg(lo))}</span><i class="wx-ramp" aria-hidden="true"></i><span class="lg-wx-v mono">${esc(deg(hi))}</span>`;
  return {
    block: `<div class="legend-wx">
      <h3 class="legend-title">${esc(t('wx_legend_title'))}</h3>
      <div class="lg-wx-scale">${ramp}</div>
      <ul class="lg-wx-icons">${icons.map((k) => `<li>${iconHtml(k, '', 'wxi lg-wxi')}<span>${esc(t(`wx_icon_${k}`))}</span></li>`).join('')}</ul>
      <p class="legend-note lg-wx-note">${esc(issuedText(w.data))} · ${esc(t('wx_tz_note'))}</p>
    </div>`,
    // phones: the legend is one scrolling strip; a compact scale item joins it
    mini: `<li class="lg-wx-mini"><span class="lg-name">${esc(t('wx_legend_mini'))}</span>${ramp}</li>`,
  };
}

export function createWeatherOverlay({ map, mapRoot, bar, openCountry, onChange }) {
  const w = state.weather;
  let markers = []; // keyboard order
  let prio = [];    // placement order
  let layer = null;
  let frame = 0;
  let timer = 0;
  let focusIdx = 0;
  let pinned = null;
  let hot = null;
  let lastPointer = 'mouse';
  let obstacles = [];
  let obstaclesAt = 0;
  const daysEl = bar.querySelector('.wxb-days');
  const playBtn = bar.querySelector('.wxb-play');

  // ---------------------------------------------------------------- data
  async function ensureData() {
    if (w.status === 'ready' || w.status === 'loading') return;
    w.status = 'loading';
    onChange?.();
    try {
      w.data = await loadWeather();
      w.status = 'ready';
    } catch (err) {
      w.status = 'error';
      state.errors.push(String(err?.message || err));
    }
    if (w.status === 'ready' && w.on) { build(); show(true); }
    onChange?.();
  }

  // ---------------------------------------------------------------- markers
  function build() {
    if (layer) return;
    layer = document.createElement('div');
    layer.className = 'wx-layer';
    layer.setAttribute('role', 'group');
    layer.dataset.testid = 'weather-layer';
    mapRoot.append(layer);
    const cities = keyboardOrder(w.data.cities.filter((c) => c.lat != null && c.lon != null), w.data.regions, 155);
    markers = cities.map((c, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'wxm';
      el.tabIndex = i === 0 ? 0 : -1;
      el.dataset.city = c.id;
      el.dataset.testid = 'weather-marker';
      if (c.iso) el.dataset.iso = c.iso;
      const pill = document.createElement('span');
      pill.className = 'wxm-pill';
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'wxi wxm-i');
      svg.setAttribute('viewBox', '0 0 32 32');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS(SVG_NS, 'use');
      svg.append(use);
      const temp = document.createElement('b');
      temp.className = 'wxm-t';
      const name = document.createElement('span');
      name.className = 'wxm-n';
      pill.append(svg, temp, name);
      const dot = document.createElement('i');
      dot.className = 'wxm-dot';
      el.append(pill, dot);
      layer.append(el);
      return { i, city: c, el, pill, use, temp, name, wS: 0, wL: 0, bx: 0, by: 0, px: 0, py: 0, ox: 0, oy: 0, vis: false, full: false, named: false };
    });
    prio = [...markers].sort((a, b) => cityRank(a.city) - cityRank(b.city));
    layer.addEventListener('pointerdown', onPointerDown);
    layer.addEventListener('pointerover', onOver);
    layer.addEventListener('pointerout', onOut);
    layer.addEventListener('pointermove', (ev) => { if (hot && !pinned) moveTip(ev.clientX, ev.clientY); });
    layer.addEventListener('click', onClick);
    layer.addEventListener('focusin', onFocus);
    layer.addEventListener('focusout', (ev) => { if (!layer.contains(ev.relatedTarget) && !pinned) unhot(); });
    layer.addEventListener('keydown', onKey);
    project();
    buildDays();
    paint();
  }

  /** Base (zoom 1) positions: after a build or a resize. */
  function project() {
    for (const m of markers) [m.bx, m.by] = map.projection([m.city.lon, m.city.lat]);
  }

  /** Day-dependent content; widths are measured once here (one layout read for all markers). */
  function paint() {
    if (!layer) return;
    for (const m of markers) {
      const d = m.city.days[w.day] || m.city.days[0];
      m.use.setAttribute('href', `#wx-${safeIcon(d.icon)}`);
      m.temp.textContent = deg(d.max ?? d.min);
      m.name.textContent = cityName(m.city);
      m.el.className = `wxm ${tempClass(d.max ?? d.min)}`;
      const country = m.city.iso ? countryName(m.city.iso) : '';
      m.el.setAttribute('aria-label', t('wx_marker', { city: cityName(m.city), country, wx: phrase(d), hi: deg(d.max), lo: deg(d.min) }));
    }
    layer.classList.add('is-measure');
    for (const m of markers) {
      m.wL = m.pill.offsetWidth;
      m.wS = m.wL - m.name.offsetWidth - 4;
    }
    layer.classList.remove('is-measure');
    layout();
    if (hot) showFor(hot, pinned === hot);
  }

  function readObstacles() {
    obstacles = [];
    for (const sel of OBSTACLES) {
      document.querySelectorAll(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') obstacles.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      });
    }
    obstaclesAt = performance.now();
  }

  function layout() {
    frame = 0;
    if (!layer || !w.on) return;
    if (performance.now() - obstaclesAt > 600) readObstacles();
    const [width, height] = map.size();
    const tr = map.transform();
    const inside = (x, y) => obstacles.some((o) => x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h);
    for (const m of markers) {
      [m.px, m.py] = tr.apply([m.bx, m.by]);
      m.vis = m.px > -8 && m.px < width + 8 && m.py > -8 && m.py < height + 8 && !inside(m.px, m.py);
    }
    declutter(prio, { bounds: { x0: 0, y0: 0, x1: width, y1: height }, obstacles, pillH: PILL_H });
    for (const m of markers) {
      m.el.style.transform = `translate(${m.px.toFixed(1)}px, ${m.py.toFixed(1)}px)`;
      m.pill.style.transform = `translate(${m.ox.toFixed(1)}px, ${m.oy.toFixed(1)}px)`;
      m.el.classList.toggle('is-full', m.full);
      m.el.classList.toggle('is-named', m.named);
      m.el.classList.toggle('is-off', !m.vis);
    }
  }
  const schedule = () => { if (!frame && layer && w.on) frame = requestAnimationFrame(layout); };

  map.onZoom((tr, src) => { if (src) stop(); schedule(); });
  map.onResize(() => { if (!layer) return; project(); obstaclesAt = 0; schedule(); });
  on('panel:open', () => { obstaclesAt = 0; schedule(); });
  on('panel:close', () => { obstaclesAt = 0; setTimeout(schedule, 350); });
  on('user:interact', () => stop());

  // ---------------------------------------------------------------- tooltip
  function tipHtml(m, touch) {
    const country = m.city.iso ? countryName(m.city.iso) : '';
    const days = m.city.days.map((d, i) => `<li class="wxt-d${i === w.day ? ' is-sel' : ''}${isWeekend(d.date) ? ' is-we' : ''}">
      <span class="wxt-dw">${esc(weekday(d.date))}</span>${iconHtml(d.icon, phrase(d), 'wxi wxt-i')}
      <b class="wxt-hi">${esc(deg(d.max))}</b><span class="wxt-lo">${esc(deg(d.min))}</span></li>`).join('');
    const hint = !m.city.iso ? t('wx_no_country') : touch ? t('wx_tap_again') : t('wx_tip_click');
    return `<div class="tip-head"><span class="tip-iata">${esc(t('wx_kicker'))}</span><span class="tip-iso">${esc(m.city.iso || '')}</span></div>
      <div class="tip-name">${esc(cityName(m.city))}</div>
      <div class="tip-alt">${esc(cityAlt(m.city))}${country ? ` · ${esc(country)}` : ''}</div>
      <ol class="wxt-days">${days}</ol>
      <div class="tip-hint">${esc(hint)}</div>`;
  }
  function showFor(m, touch = false, ev = null) {
    hot = m;
    markers.forEach((x) => x.el.classList.toggle('is-hot', x === m));
    const r = m.el.querySelector('.wxm-dot').getBoundingClientRect();
    showTip(tipHtml(m, touch), ev?.clientX ?? r.left + r.width / 2 + 6, ev?.clientY ?? r.top + r.height / 2 + 6);
  }
  function unhot() {
    if (!hot) return;
    hot.el.classList.remove('is-hot');
    hot = null;
    pinned = null;
    hideTip();
  }

  // ---------------------------------------------------------------- interaction
  const markerOf = (ev) => {
    const el = ev.target?.closest?.('.wxm');
    return el ? markers.find((m) => m.el === el) : null;
  };
  function activate(m) {
    if (!m?.city.iso) return;
    unhot();
    stop();
    openCountry(m.city.iso);
  }
  function onPointerDown(ev) {
    lastPointer = ev.pointerType || 'mouse';
    stop();
  }
  function onOver(ev) {
    const m = markerOf(ev);
    if (!m || ev.pointerType === 'touch' || pinned) return;
    if (m.el !== document.activeElement) layer.append(m.el); // hovered marker on top
    showFor(m, false, ev);
  }
  function onOut(ev) {
    const m = markerOf(ev);
    if (!m || pinned || m.el.contains(ev.relatedTarget) || m.el === document.activeElement) return;
    unhot();
  }
  function onClick(ev) {
    const m = markerOf(ev);
    if (!m) return;
    ev.stopPropagation();
    if (lastPointer === 'touch' && pinned !== m && ev.detail !== 0) { // first tap: forecast; second tap: open
      pinned = m;
      showFor(m, true);
      return;
    }
    activate(m);
  }
  function onFocus(ev) {
    const m = markerOf(ev);
    if (!m) return;
    focusIdx = m.i;
    markers.forEach((x) => { x.el.tabIndex = x === m ? 0 : -1; });
    showFor(m);
  }
  function focusStep(from, step) {
    const n = markers.length;
    for (let k = 1; k <= n; k++) {
      const m = markers[(((from + step * k) % n) + n) % n];
      if (m.vis) { m.el.focus(); return; }
    }
  }
  function onKey(ev) {
    const m = markerOf(ev);
    if (!m) return;
    lastPointer = 'keyboard';
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    if (step) { ev.preventDefault(); stop(); focusStep(m.i, step); }
    else if (ev.key === 'Home') { ev.preventDefault(); focusStep(-1, 1); }
    else if (ev.key === 'End') { ev.preventDefault(); focusStep(markers.length, -1); }
    else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(m); }
    else if (ev.key === 'Escape') { ev.stopPropagation(); unhot(); }
  }
  document.addEventListener('pointerdown', (ev) => { if (pinned && !layer?.contains(ev.target)) unhot(); });

  // ---------------------------------------------------------------- day bar + play
  function buildDays() {
    const days = w.data?.days || [];
    daysEl.replaceChildren(...days.map((date, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `wxb-day${isWeekend(date) ? ' is-we' : ''}`;
      b.dataset.day = String(i);
      b.dataset.testid = `weather-day-${i}`;
      b.setAttribute('aria-pressed', String(i === w.day));
      const wd = document.createElement('span');
      wd.className = 'wd';
      wd.textContent = weekday(date);
      const md = document.createElement('time');
      md.className = 'md';
      md.dateTime = date;
      md.textContent = monthDay(date);
      b.append(wd, md);
      return b;
    }));
    renderPlay();
  }
  function setDay(i) {
    const n = w.data?.days.length || 7;
    w.day = ((i % n) + n) % n;
    daysEl.querySelectorAll('[data-day]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.day === w.day)));
    paint();
    // the open panel's table highlights the same day (no full panel re-render)
    document.querySelectorAll('#panel .wx-ptable [data-day]').forEach((c) => c.classList.toggle('is-sel', +c.dataset.day === w.day));
  }
  function renderPlay() {
    playBtn.setAttribute('aria-pressed', String(!!timer));
    playBtn.querySelector('.wxb-play-t').textContent = timer ? t('wx_stop') : t('wx_play');
    playBtn.title = t('wx_play_title');
  }
  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = 0;
    renderPlay();
  }
  daysEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-day]');
    if (!b) return;
    stop();
    setDay(+b.dataset.day);
  });
  daysEl.addEventListener('keydown', (ev) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
    if (!step || !ev.target.closest('[data-day]')) return;
    ev.preventDefault();
    stop();
    setDay(w.day + step);
    daysEl.querySelector(`[data-day="${w.day}"]`)?.focus();
  });
  playBtn.addEventListener('click', () => { // only ever started by the user (never autoplays)
    if (timer) { stop(); return; }
    setDay(w.day + 1);
    timer = setInterval(() => setDay(w.day + 1), PLAY_MS);
    renderPlay();
  });
  mapRoot.addEventListener('pointerdown', () => stop());
  mapRoot.addEventListener('wheel', () => stop(), { passive: true });

  // ---------------------------------------------------------------- on / off
  function show(v) {
    bar.hidden = !v || w.status !== 'ready';
    document.body.classList.toggle('wx-on', v);
    if (layer) layer.hidden = !v;
    if (!v) { stop(); unhot(); }
    obstaclesAt = 0;
    if (v) schedule();
  }

  function setOn(v) {
    w.on = v;
    show(v);
    if (v) ensureData();
  }

  /** Panel section (panel.js): this country's CWA cities, 7 days each. */
  const panelProvider = {
    has: (iso) => !!(w.on && w.status === 'ready' && w.data?.cities.some((c) => c.iso === iso)),
    html(iso) {
      const cities = w.data.cities.filter((c) => c.iso === iso);
      const days = w.data.days;
      const head = days.map((date, i) => `<th scope="col" data-day="${i}" class="${i === w.day ? 'is-sel' : ''}${isWeekend(date) ? ' is-we' : ''}"><span class="wd">${esc(weekday(date))}</span><span class="md mono">${esc(monthDay(date))}</span></th>`).join('');
      const rows = cities.map((c) => `<tr><th scope="row"><b>${esc(cityName(c))}</b><span>${esc(cityAlt(c))}</span></th>${days.map((date, i) => {
        const d = c.days.find((x) => x.date === date);
        if (!d) return `<td data-day="${i}">–</td>`;
        return `<td data-day="${i}" class="${i === w.day ? 'is-sel' : ''}${WET.has(d.icon) ? ' is-wet' : ''}">${iconHtml(d.icon, phrase(d), 'wxi wx-pi')}<b>${esc(deg(d.max))}</b><span>${esc(deg(d.min))}</span></td>`;
      }).join('')}</tr>`).join('');
      return `<p class="wx-psub">${esc(issuedText(w.data))} · ${esc(t('wx_tz_note'))}</p>
        <div class="wx-ptable-wrap"><table class="wx-ptable">
          <caption class="sr-only">${esc(t('wx_caption', { country: countryName(iso) }))}</caption>
          <thead><tr><th scope="col" class="wx-pc">${esc(t('wx_city'))}</th>${head}</tr></thead>
          <tbody>${rows}</tbody></table></div>`;
    },
  };

  return {
    setOn,
    panelProvider,
    /** Language changed: names, labels, day buttons. */
    refresh() {
      if (layer) layer.setAttribute('aria-label', t('wx_layer_label'));
      if (w.status !== 'ready' || !layer) return;
      buildDays();
      paint();
    },
    debug: { setDay, markers: () => markers.length, layout: () => layout() },
  };
}
