// Header HUD (clock, stat tiles, freshness), legend, and flight HUD.
import {
  state, levelOf, warnLevel, warnPartial, mofaMode, activeHubs, hubData,
} from './state.js';
import {
  t, fmtNum, fmtDateTime, fmtRelative, fmtDay, levelShort, getLang, wLevelShort,
} from './i18n.js';
import {
  esc, reducedMotion, todayTaipei, parseDay, finiteNum, $,
} from './util.js';

let clockTimer = 0;
const LOW_END = (navigator.hardwareConcurrency || 8) <= 4
  || (typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches);

// Intl formatters are expensive to construct: build them once (per language), not every second.
const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const dateFmts = new Map();
function dateFmt(lang) {
  if (!dateFmts.has(lang)) {
    dateFmts.set(lang, new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'zh-Hant-TW', {
      timeZone: 'Asia/Taipei', month: 'short', day: 'numeric', weekday: 'short',
    }));
  }
  return dateFmts.get(lang);
}

export function startClock(node) {
  const timeEl = node.querySelector('.clock-time');
  const dateEl = node.querySelector('.clock-date');
  const tick = () => {
    const now = new Date();
    const time = TIME_FMT.format(now);
    const date = dateFmt(getLang()).format(now);
    if (timeEl.textContent !== time) timeEl.textContent = time;
    if (dateEl.textContent !== date) dateEl.textContent = date;
  };
  tick();
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, 1000);
  return tick;
}

/** Counts derived from alerts.json, used when meta.json is missing. */
function derivedCounts() {
  const c = state.data.alerts?.countries || {};
  const out = { countries_with_alerts: 0, level3: 0, level2: 0, level1: 0 };
  for (const v of Object.values(c)) {
    if (!v.max_level) continue;
    out.countries_with_alerts++;
    out[`level${v.max_level}`]++;
  }
  return out;
}

export function renderTiles(node, { animate = false } = {}) {
  // count-up is decoration: skip it on low-end devices (each step re-lays out the header)
  const anim = animate && !reducedMotion() && !LOW_END;
  const meta = state.data.meta;
  const counts = { ...derivedCounts(), ...(meta?.counts || {}) };
  if (state.data.epidemics && counts.epidemic_items == null) counts.epidemic_items = state.data.epidemics.items.length;
  const tiles = [
    { key: 'tile_countries', v: counts.countries_with_alerts, cls: 'tile-accent' },
    { key: 'tile_l3', v: counts.level3, cls: 'tile-l3', lvl: 3 },
    { key: 'tile_l2', v: counts.level2, cls: 'tile-l2', lvl: 2 },
    { key: 'tile_l1', v: counts.level1, cls: 'tile-l1', lvl: 1 },
    { key: 'tile_epidemics', v: counts.epidemic_items, cls: '' },
    { key: 'tile_ai', v: counts.ai_translated, cls: 'tile-ai' },
  ];
  node.innerHTML = tiles.map((x) => `
    <li class="tile ${x.cls}">
      <span class="tile-label">${x.lvl ? `<i class="dot lvl-${x.lvl}" aria-hidden="true"></i>` : ''}${esc(t(x.key))}</span>
      <b class="tile-val mono" data-v="${x.v == null ? '' : finiteNum(x.v)}">${x.v == null ? '—' : fmtNum(anim ? 0 : finiteNum(x.v))}</b>
    </li>`).join('') + `
    <li class="tile tile-updated">
      <span class="tile-label">${esc(t('tile_updated'))}</span>
      <b class="tile-val mono small">${meta?.generated_at ? esc(fmtDateTime(meta.generated_at)) : '—'}</b>
    </li>`;
  if (anim) countUp(node);
  else node.querySelectorAll('.tile-val[data-v]').forEach((b) => { if (b.dataset.v !== '') b.textContent = fmtNum(+b.dataset.v); });
}

function countUp(node) {
  const els = Array.from(node.querySelectorAll('.tile-val[data-v]')).filter((b) => b.dataset.v !== '');
  const t0 = performance.now();
  const D = 1400;
  const frame = (now) => {
    const p = Math.min(1, (now - t0) / D);
    const e = 1 - (1 - p) ** 3;
    els.forEach((b) => { b.textContent = fmtNum(Math.round(+b.dataset.v * e)); });
    if (p < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

export function renderFreshness(node) {
  const gen = state.data.meta?.generated_at || state.data.alerts?.generated_at;
  let cls = 'fresh-unknown';
  let text = t('fresh_unknown');
  if (gen) {
    const ageH = (Date.now() - new Date(gen).getTime()) / 3.6e6;
    const ago = fmtRelative(gen);
    if (ageH < 1) { cls = 'fresh-live'; text = t('fresh_ok', { ago }); }
    else if (ageH < 26) { cls = 'fresh-ok'; text = t('fresh_ok', { ago }); }
    else { cls = 'fresh-stale'; text = t('fresh_stale', { ago }); }
  }
  node.className = `freshness ${cls}`;
  node.innerHTML = `<i class="pulse-dot" aria-hidden="true"></i><span>${esc(text)}</span>`;
  node.title = gen ? fmtDateTime(gen) : '';
}

// Optional extra legend content (weather overlay, js/weather.js): set once that module has loaded.
let legendExtra = null;
export function setLegendExtra(fn) { legendExtra = fn; }
const extra = () => legendExtra?.() || { block: '', mini: '' };

// Outbreak route watch entries (js/watch.js): [{ name, reason }] of the sets on the map, set once that module exists.
let legendWatch = null;
export function setLegendWatch(fn) { legendWatch = fn; }

function flightLegend() {
  const watch = legendWatch?.() || [];
  const both = state.flightDir === 'both';
  const hubs = state.flightsOn ? activeHubs() : [];
  const rows = [];
  if (hubs.includes('TPE')) {
    rows.push(`<li><span class="swatch-line in" aria-hidden="true"></span><span class="lg-name">${esc(t('legend_in'))}</span></li>`);
    if (both) rows.push(`<li><span class="swatch-line out" aria-hidden="true"></span><span class="lg-name">${esc(t('legend_out'))}</span></li>`);
  }
  if (hubs.some((c) => c !== 'TPE')) { // other airports on: one colour each
    for (const c of hubs.filter((x) => x !== 'TPE')) {
      rows.push(`<li><span class="swatch-line hub-${c.toLowerCase()}" aria-hidden="true"></span><span class="lg-name">${esc(t('legend_hub', { name: t(`hub_${c}`), code: c }))}</span></li>`);
    }
  }
  for (const w of watch) {
    rows.push(`<li class="lg-watch"><span class="swatch-line watch" aria-hidden="true"></span><span class="lg-name">${
      esc(t('legend_watch', { name: w.name }))}${w.reason ? `<small>${esc(w.reason)}</small>` : ''}</span></li>`);
  }
  if (watch.length) {
    rows.push(`<li class="lg-watch"><span class="swatch-dot tpe" aria-hidden="true"></span><span class="lg-name">${esc(t('legend_watch_tpe'))}</span></li>`);
  }
  return rows.length ? `<ul class="legend-list legend-flights">${rows.join('')}</ul>` : '';
}

// Level rows are the map filter: a pressed row is shown, none pressed = every level.
function levelRow(l, sw, name, count, filter) {
  const on = filter.has(l);
  const dim = filter.size > 0 && !on;
  return `<li class="lg-row"><button type="button" class="lg-filter${dim ? ' is-dim' : ''}" data-level="${l}" aria-pressed="${on}" title="${esc(t('legend_tap_filter'))}">
      <span class="swatch ${sw}" aria-hidden="true"></span><span class="lg-name">${esc(name)}</span><b class="mono">${fmtNum(count)}</b></button></li>`;
}

/** Collapsed to its title bar? Beside a left-docked arrivals board it starts collapsed (own toggle, not remembered). */
export const legendDocked = () => document.body.classList.contains('arr-dock-left');
export const legendCollapsed = () => (legendDocked() ? !state.legendDockOpen : !!state.legendMin);

function legendHead(title, filter) {
  return `<div class="legend-head">
      <h2 class="legend-title">${esc(title)}</h2>
      ${filter.size ? `<button type="button" class="lg-all" data-level="all">${esc(t('filter_all'))}</button>` : ''}
      <button type="button" class="lg-min" data-legend-min aria-expanded="${!legendCollapsed()}" title="${esc(t(legendCollapsed() ? 'legend_expand' : 'legend_collapse'))}"
        aria-label="${esc(t(legendCollapsed() ? 'legend_expand' : 'legend_collapse'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
    </div>`; // how to use it (tap a level to filter, wheel / drag / double-click) is in each button's title and help.html
}

function renderWarnLegend(node) {
  const wx = extra();
  const w = state.data.warnings?.countries || {};
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  let partial = 0;
  for (const iso of Object.keys(w)) {
    if (warnLevel(iso)) counts[warnLevel(iso)]++;
    if (warnPartial(iso)) partial++;
  }
  const geoIds = Array.from(state.data.worldNames.keys()).filter((id) => /^[A-Z]{2}$/.test(id) && id !== 'TW');
  counts[0] = geoIds.filter((id) => !warnLevel(id)).length;
  const rows = [4, 3, 2, 1].map((l) => levelRow(l, `wl-${l}`, wLevelShort(l), counts[l], state.wfilter)).join('');
  node.innerHTML = `
    ${legendHead(t('wl_legend_title'), state.wfilter)}
    <div class="legend-body">
    <ul class="legend-list">${rows}
      <li class="lg-static"><span class="swatch wl-0" aria-hidden="true"></span><span class="lg-name">${esc(t('wl_legend_none'))}</span><b class="mono">${fmtNum(counts[0])}</b></li>
      <li class="lg-static"><span class="swatch swatch-part" aria-hidden="true"></span><span class="lg-name">${esc(t('wl_legend_partial'))}</span><b class="mono">${fmtNum(partial)}</b></li>
      <li class="lg-static"><span class="swatch swatch-home" aria-hidden="true"></span><span class="lg-name">${esc(t('legend_home'))}</span></li>${wx.mini}
    </ul>
    ${flightLegend()}${wx.block}
    </div>`;
}

export function renderLegend(node) {
  node.classList.remove('is-pending');
  node.classList.toggle('is-mofa', mofaMode());
  node.classList.toggle('is-min', legendCollapsed());
  if (mofaMode()) { renderWarnLegend(node); return; }
  const wx = extra();
  const c = state.data.alerts?.countries || {};
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const v of Object.values(c)) counts[v.max_level || 0]++;
  const geoIds = Array.from(state.data.worldNames.keys()).filter((id) => /^[A-Z]{2}$/.test(id) && id !== 'TW');
  counts[0] = geoIds.filter((id) => !levelOf(id)).length;
  const rows = [3, 2, 1].map((l) => levelRow(l, `lvl-${l}`, levelShort(l), counts[l], state.filter)).join('');
  node.innerHTML = `
    ${legendHead(t('legend_title'), state.filter)}
    <div class="legend-body">
    <ul class="legend-list">${rows}
      <li class="lg-static"><span class="swatch lvl-0" aria-hidden="true"></span><span class="lg-name">${esc(t('level_0'))}</span><b class="mono">${fmtNum(counts[0])}</b></li>
      <li class="lg-static"><span class="swatch swatch-home" aria-hidden="true"></span><span class="lg-name">${esc(t('legend_home'))}</span></li>${wx.mini}
    </ul>
    ${flightLegend()}${wx.block}
    </div>`;
}

export function renderFlightHud(node) {
  node.classList.remove('is-pending');
  const f = state.data.flights;
  const stats = $('.fh-stats', node);
  const btn = document.querySelector('.fh-toggle');
  btn.setAttribute('aria-pressed', String(state.flightsOn));
  btn.querySelector('.fh-toggle-text').textContent = t('flights_toggle'); // the switch knob shows on / off
  node.hidden = !state.flightsOn; // the route box only while the routes are on the map (the switch is in the layer row)
  btn.querySelector('.fh-toggle-sr').textContent = t('flights_toggle_sr'); // name = visible text + description
  btn.title = t('flights_toggle_label');
  const dirNode = $('.fh-dir', node);
  if (dirNode) {
    const both = state.flightDir === 'both';
    dirNode.setAttribute('aria-label', t('flights_dir_label'));
    dirNode.hidden = !state.flightsOn || !f?.routes;
    dirNode.innerHTML = `
      <button type="button" data-dir="in" aria-pressed="${!both}"><i class="dot in" aria-hidden="true"></i>${esc(t('flights_dir_in'))}</button>
      <button type="button" data-dir="both" aria-pressed="${both}">${esc(t('flights_dir_both'))}</button>`;
  }
  const hubs = activeHubs();
  const title = $('.fh-title', node);
  if (title) title.textContent = hubs.length && (hubs.length > 1 || hubs[0] !== 'TPE') ? t('flights_title_hubs', { codes: hubs.join(' · ') }) : t('flights_title');
  if (!f || !f.routes) {
    stats.innerHTML = `<span class="fh-warn">${esc(t('flights_unavailable'))}</span>`;
    btn.disabled = true;
    return;
  }
  // totals over the switched-on airports (a destination served by two of them counts once)
  const all = hubs.map((c) => hubData(c));
  const dest = new Set(all.flatMap((d) => d.routes.map((r) => r.iata))).size;
  const sum = (k) => all.reduce((s, d) => s + (d.totals?.[k] ?? d.routes.reduce((x, r) => x + (r[k] || 0), 0)), 0);
  const dep = sum('departures');
  const arr = sum('arrivals');
  const date = all.map((d) => d.date).sort()[0] || f.date; // the oldest one decides "stale"
  const today = todayTaipei();
  const fd = parseDay(date);
  const stale = (hubs.includes('TPE') && state.data.meta?.sources?.flights?.ok === false) || (fd && today && +fd !== +today);
  stats.innerHTML = `
    <div><span>${esc(t('flights_dest'))}</span><b class="mono">${fmtNum(dest)}</b></div>
    <div${state.flightDir === 'both' ? '' : ' class="is-off"'}><span>${esc(t('flights_dep'))}</span><b class="mono out">${fmtNum(dep)}</b></div>
    <div><span>${esc(t('flights_arr'))}</span><b class="mono in">${fmtNum(arr)}</b></div>
    <div><span>${esc(t('flights_date'))}</span><b class="mono small${stale ? ' warn' : ''}" title="${esc(stale ? `${fmtDay(date)} · ${t('flights_stale')}` : fmtDay(date))}">${esc(String(date || '').slice(5) || '—')}</b></div>`;
}
