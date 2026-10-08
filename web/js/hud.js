// Header HUD (clock, stat tiles, freshness), legend, and flight HUD.
import { state, levelOf } from './state.js';
import { t, fmtNum, fmtDateTime, fmtRelative, fmtDay, levelShort, getLang } from './i18n.js';
import { esc, reducedMotion, todayTaipei, parseDay, $ } from './util.js';

let clockTimer = 0;

export function startClock(node) {
  const tick = () => {
    const now = new Date();
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(now);
    const date = new Intl.DateTimeFormat(getLang() === 'en' ? 'en-GB' : 'zh-Hant-TW', {
      timeZone: 'Asia/Taipei', month: 'short', day: 'numeric', weekday: 'short',
    }).format(now);
    node.querySelector('.clock-time').textContent = time;
    node.querySelector('.clock-date').textContent = date;
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
      <b class="tile-val mono" data-v="${x.v ?? ''}">${x.v == null ? '—' : fmtNum(animate ? 0 : x.v)}</b>
    </li>`).join('') + `
    <li class="tile tile-updated">
      <span class="tile-label">${esc(t('tile_updated'))}</span>
      <b class="tile-val mono small">${meta?.generated_at ? esc(fmtDateTime(meta.generated_at)) : '—'}</b>
    </li>`;
  if (animate && !reducedMotion()) countUp(node);
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

export function renderLegend(node) {
  const c = state.data.alerts?.countries || {};
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const v of Object.values(c)) counts[v.max_level || 0]++;
  const geoIds = Array.from(state.data.worldNames.keys()).filter((id) => /^[A-Z]{2}$/.test(id) && id !== 'TW');
  counts[0] = geoIds.filter((id) => !levelOf(id)).length;
  const unmapped = state.data.alerts?.unmapped?.length || 0;
  const rows = [3, 2, 1, 0].map((l) => `
    <li><span class="swatch lvl-${l}" aria-hidden="true"></span><span class="lg-name">${esc(l ? levelShort(l) : t('level_0'))}</span><b class="mono">${fmtNum(counts[l])}</b></li>`).join('');
  node.innerHTML = `
    <h2 class="legend-title">${esc(t('legend_title'))}</h2>
    <ul class="legend-list">${rows}
      <li><span class="swatch swatch-home" aria-hidden="true"></span><span class="lg-name">${esc(t('legend_home'))}</span></li>
    </ul>
    ${state.data.flights?.routes?.length ? `<ul class="legend-list legend-flights">
      <li><span class="swatch-line out" aria-hidden="true"></span><span class="lg-name">${esc(t('legend_out'))}</span></li>
      <li><span class="swatch-line in" aria-hidden="true"></span><span class="lg-name">${esc(t('legend_in'))}</span></li>
    </ul>` : ''}
    ${unmapped ? `<p class="legend-note">${esc(t('legend_unmapped', { n: unmapped }))}</p>` : ''}
    <p class="legend-hint">${esc(t('map_hint'))}</p>`;
}

export function renderFlightHud(node) {
  const f = state.data.flights;
  const stats = $('.fh-stats', node);
  const btn = $('.fh-toggle', node);
  btn.setAttribute('aria-pressed', String(state.flightsOn));
  btn.querySelector('.fh-toggle-text').textContent = state.flightsOn ? t('flights_toggle_on') : t('flights_toggle_off');
  btn.setAttribute('aria-label', t('flights_toggle_label'));
  btn.title = t('flights_toggle_label');
  if (!f || !f.routes) {
    stats.innerHTML = `<span class="fh-warn">${esc(t('flights_unavailable'))}</span>`;
    btn.disabled = true;
    return;
  }
  const totals = f.totals || {};
  const dest = totals.destinations ?? f.routes.length;
  const dep = totals.departures ?? f.routes.reduce((s, r) => s + (r.departures || 0), 0);
  const arr = totals.arrivals ?? f.routes.reduce((s, r) => s + (r.arrivals || 0), 0);
  const today = todayTaipei();
  const fd = parseDay(f.date);
  const stale = state.data.meta?.sources?.flights?.ok === false || (fd && today && +fd !== +today);
  stats.innerHTML = `
    <div><span>${esc(t('flights_dest'))}</span><b class="mono">${fmtNum(dest)}</b></div>
    <div><span>${esc(t('flights_dep'))}</span><b class="mono out">${fmtNum(dep)}</b></div>
    <div><span>${esc(t('flights_arr'))}</span><b class="mono in">${fmtNum(arr)}</b></div>
    <div><span>${esc(t('flights_date'))}</span><b class="mono small${stale ? ' warn' : ''}" ${stale ? `title="${esc(t('flights_stale'))}"` : ''}>${esc(fmtDay(f.date, 'short'))}</b></div>`;
}
