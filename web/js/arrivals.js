// Inbound flights board for airport quarantine stations: passenger flights arriving within ±60 min (±30 / ±120 /
// the whole published window on request) at the
// chosen Taiwan airport / checkpoint, with the origin country's advisory level, plus a map layer of their routes.
// Data: data/arrivals.json (docs/ARRIVALS.md), published every 10 min (30 min at night) outside git.
import { state, emit, levelOf, groupAlerts } from './state.js';
import {
  t, isEn, countryName, diseaseName, badge, levelShort,
} from './i18n.js';
import {
  esc, storageGet, storageSet, debounce, clamp, levelNum, reducedMotion, AUTO_SCROLL_PX_S,
} from './util.js';
import { loadPlaces, airportMatches } from './places.js';

const d3 = window.d3;
const ON_KEY = 'safetravel.arrivals';
const CFG_KEY = 'safetravel.arrivals.cfg';
const POS_KEY = 'safetravel.arrivals.pos';
const WINDOWS = [30, 60, 120, 0]; // ± minutes around now; 0 = the whole published window (2 h back … 4 h ahead)
const POLL_MS = 60 * 1000;
const TICK_MS = 20 * 1000;
// unattended wall screens: the list glides down at a reading pace, rests at both ends, then starts over
const SCROLL_PX_S = AUTO_SCROLL_PX_S; // same pace as the country panel's auto-scroll (util.js)
const REST_TOP_MS = 5000;
const REST_BOTTOM_MS = 6000;
const HOLD_MS = 15000; // pause after a person touches / scrolls / clicks the list
const HOVER_HOLD_MS = 8000; // pause while a mouse is actually moving over it (a parked cursor does not block)
const STATUSES = new Set(['arrived', 'on_time', 'early', 'delayed', 'changed', 'cancelled', 'other']);
const AIRPORT_ORDER = ['TPE', 'TSA', 'KHH', 'RMQ', 'TNN', 'HUN'];
const PLANE = 'M0-5.5 1.1-1.6 5.5 1.3V2.6L1.1 1.1.8 4 2.3 5.1V6L0 5.3-2.3 6V5.1L-.8 4-1.1 1.1-5.5 2.6V1.3L-1.1-1.6Z';

const HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hm = (ms) => (Number.isFinite(ms) ? HM.format(ms) : '—');
const ts = (s) => (s ? Date.parse(s) : NaN);

function readJSON(key) {
  try { return JSON.parse(storageGet(key) || 'null'); } catch { return null; }
}

/** ?arr=TPE-C (airport + checkpoint), ?arr=KHH, &big=1, &win=30|60|120|all */
function fromUrl(standalone) {
  const q = new URLSearchParams(location.search);
  const m = /^([A-Za-z]{3})(?:-([A-Da-d]))?$/.exec(q.get('arr') || '');
  const w = q.get('win');
  const win = w === 'all' ? 0 : WINDOWS.includes(Number(w)) && w ? Number(w) : undefined;
  if (!m) return standalone && (win !== undefined || q.get('big')) ? { win, big: q.get('big') === '1' ? true : undefined } : null;
  return {
    airport: m[1].toUpperCase(), cp: m[2] ? m[2].toUpperCase() : 'ALL', big: q.get('big') === '1' ? true : undefined, win,
  };
}

/** Canonical flight key: upper-case letters and digits only, leading zeros of the number dropped (CI0006 = CI 6). */
export const flightKey = (s) => String(s || '').normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '')
  .replace(/^([A-Z][A-Z0-9]|[0-9][A-Z])0+(?=\d)/, '$1');

export const bestTime = (f) => ts(f.status === 'cancelled' ? f.scheduled : (f.actual || f.estimated || f.scheduled));

/**
 * The board. `standalone` (arrivals.html): always open, fills its page, no map layer / dock / drag / close.
 */
export function createArrivals({ root, button, map, openCountry, onLayout, standalone = false }) {
  const head = root.querySelector('.arr-head');
  const selAirport = root.querySelector('.arr-airport');
  const cpsNode = root.querySelector('.arr-cps');
  const statusNode = root.querySelector('.arr-status');
  const body = root.querySelector('.arr-body');
  const qInput = root.querySelector('.arr-q');
  const btnBig = root.querySelector('.arr-big');
  const btnDock = root.querySelector('.arr-dock');
  const btnMin = root.querySelector('.arr-min');
  const btnClose = root.querySelector('.arr-close');
  const swScroll = root.querySelector('.arr-scroll');

  const winNode = root.querySelector('.arr-win');
  const url = fromUrl(standalone);
  const cfg = { airport: 'TPE', cp: 'ALL', big: false, scroll: true, win: 60, risk: false, ...(readJSON(CFG_KEY) || {}) };
  if (!WINDOWS.includes(cfg.win)) cfg.win = 60;
  if (url) Object.assign(cfg, Object.fromEntries(Object.entries(url).filter(([, v]) => v !== undefined)));
  let positions = readJSON(POS_KEY) || {};
  let on = standalone || (url ? true : storageGet(ON_KEY) === 'on');
  let minimized = false;
  let data = null;
  let status = 'idle'; // idle | loading | ready | none | error
  let pollTimer = 0;
  let tickTimer = 0;
  let hotId = null;

  // ---------------------------------------------------------------- layout
  const mq = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
  const mode = () => (mq('(max-width: 760px)') ? 'phone' : window.innerHeight > window.innerWidth ? 'portrait' : 'landscape');
  const floating = () => !standalone && mode() !== 'phone' && !!positions[mode()];

  function measureTop() {
    const tb = document.querySelector('.toolbar')?.getBoundingClientRect();
    document.documentElement.style.setProperty('--arr-top', `${Math.round((tb?.bottom || 220) + 10)}px`);
  }

  function applyLayout() {
    const m = mode();
    const fl = floating();
    root.classList.toggle('is-floating', fl);
    root.dataset.mode = m;
    document.body.classList.toggle('arr-open', on);
    document.body.classList.toggle('arr-dock-left', on && !fl && m === 'landscape' && !minimized);
    document.body.classList.toggle('arr-dock-top', on && !fl && m === 'portrait');
    if (fl) {
      const p = positions[m];
      const w = clamp(p.w || 420, 300, window.innerWidth - 16);
      const h = clamp(p.h || 520, 160, window.innerHeight - 16);
      root.style.width = `${w}px`;
      root.style.height = minimized ? '' : `${h}px`;
      root.style.left = `${clamp(p.x, 8, window.innerWidth - w - 8)}px`;
      root.style.top = `${clamp(p.y, 8, window.innerHeight - 60)}px`;
    } else {
      root.style.width = root.style.height = root.style.left = root.style.top = '';
    }
  }

  /** Map insets so the world refits around a docked board (null = no board / floating / phone). */
  function insets() {
    if (standalone || !on || minimized || floating()) return null;
    const m = mode();
    if (m === 'phone') return null;
    const r = root.getBoundingClientRect();
    if (m === 'landscape') return { left: r.right + 8 };
    return { top: r.bottom + 8 };
  }

  // ---------------------------------------------------------------- data
  async function load() {
    if (status !== 'ready') status = 'loading';
    try {
      const res = await fetch(`data/arrivals.json?t=${Math.floor(Date.now() / 30000)}`, { cache: 'no-store' });
      if (res.status === 404) { data = null; status = 'none'; } else {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (!d || !Array.isArray(d.flights) || typeof d.airports !== 'object') throw new Error('bad arrivals.json');
        data = d;
        status = 'ready';
      }
    } catch {
      status = data ? 'ready' : 'error'; // keep showing the last good board
    }
    render();
  }

  function startPolling() {
    stopPolling();
    load();
    pollTimer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    tickTimer = setInterval(() => { if (!document.hidden) render(); }, TICK_MS);
  }
  // ---------------------------------------------------------------- auto-scroll
  const glide = { raf: 0, last: 0, pos: 0, phase: 'rest-top', until: 0, holdUntil: 0 };
  function glideFrame(ts) {
    glide.raf = requestAnimationFrame(glideFrame);
    const dt = glide.last ? Math.min(100, ts - glide.last) : 0;
    glide.last = ts;
    const max = body.scrollHeight - body.clientHeight;
    if (!on || !cfg.scroll || minimized || document.hidden || max < 8) { glide.phase = 'rest-top'; glide.until = ts + REST_TOP_MS; return; }
    const now = Date.now();
    if (now < glide.holdUntil) { glide.pos = body.scrollTop; return; }
    if (Math.abs(body.scrollTop - glide.pos) > 3) glide.pos = body.scrollTop; // re-render or manual change
    if (glide.phase === 'rest-top' || glide.phase === 'rest-bottom') {
      if (ts < glide.until) return;
      if (glide.phase === 'rest-bottom') {
        glide.pos = 0;
        body.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
        glide.phase = 'rest-top';
        glide.until = ts + REST_TOP_MS;
        return;
      }
      glide.phase = 'down';
    }
    if (reducedMotion()) { // no gliding: turn a page every few seconds
      glide.pos = Math.min(max, glide.pos + body.clientHeight * 0.8);
      body.scrollTop = glide.pos;
      glide.phase = glide.pos >= max - 1 ? 'rest-bottom' : 'rest-top';
      glide.until = ts + (glide.phase === 'rest-bottom' ? REST_BOTTOM_MS : REST_TOP_MS);
      return;
    }
    glide.pos = Math.min(max, glide.pos + (SCROLL_PX_S * (cfg.big ? 1.3 : 1) * dt) / 1000);
    body.scrollTop = glide.pos;
    if (glide.pos >= max - 0.5) { glide.phase = 'rest-bottom'; glide.until = ts + REST_BOTTOM_MS; }
  }
  function startGlide() {
    if (glide.raf) return;
    glide.last = 0;
    glide.pos = body.scrollTop;
    glide.phase = 'rest-top';
    glide.until = performance.now() + REST_TOP_MS;
    glide.raf = requestAnimationFrame(glideFrame);
  }
  function stopGlide() { cancelAnimationFrame(glide.raf); glide.raf = 0; }
  const holdGlide = (ms = HOLD_MS) => { glide.holdUntil = Math.max(glide.holdUntil, Date.now() + ms); };
  ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach((ev) => body.addEventListener(ev, () => holdGlide(), { passive: true }));
  body.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') holdGlide(HOVER_HOLD_MS); }, { passive: true });
  function renderScrollSwitch() {
    swScroll?.setAttribute('aria-pressed', String(!!cfg.scroll));
  }

  function stopPolling() {
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    pollTimer = tickTimer = 0;
  }
  document.addEventListener('visibilitychange', () => { if (on && !document.hidden) load(); });

  // ---------------------------------------------------------------- selection
  function airports() {
    const a = data?.airports || {};
    return Object.keys(a).sort((x, y) => {
      const ix = AIRPORT_ORDER.indexOf(x);
      const iy = AIRPORT_ORDER.indexOf(y);
      return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy) || x.localeCompare(y);
    });
  }
  const airportInfo = () => data?.airports?.[cfg.airport] || null;
  const checkpoints = () => (Array.isArray(airportInfo()?.checkpoints) ? airportInfo().checkpoints : []);

  function matchesCp(f) {
    if (cfg.cp === 'ALL' || !checkpoints().length) return true;
    if (f.checkpoint) return f.checkpoint === cfg.cp;
    const term = checkpoints().find((c) => c.id === cfg.cp)?.terminal;
    return !term || !f.terminal || String(f.terminal) === String(term); // gate TBD: every checkpoint of its terminal
  }

  // ---------------------------------------------------------------- flight search ("JK202", "jk-202", "JK 0202", "NRT", "東京", "名古屋")
  const placeKey = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\-_.]+/g, '');
  let query = '';
  function matchesQuery(f) {
    const q = flightKey(query);
    if (q && [f.flight, ...(Array.isArray(f.codeshares) ? f.codeshares : [])].some((x) => flightKey(x).startsWith(q))) return true;
    const p = placeKey(query);
    if (p.length < 2) return false;
    // the board's own names, then every name the place index knows for the airport ("名古屋", "Nagoya" for NGO 中部)
    return [f.from, f.from_zh, f.from_en].some((x) => placeKey(x).includes(p)) || airportMatches(f.from, query);
  }

  function visible(now = Date.now()) {
    const up = [];
    const past = [];
    const searching = !!query.trim();
    for (const f of data?.flights || []) {
      // a search looks at every checkpoint and the whole published window (2 h back … 4 h ahead), not just ±60 min
      if (f.airport !== cfg.airport || (searching ? !matchesQuery(f) : !matchesCp(f))) continue;
      const tm = bestTime(f);
      if (!Number.isFinite(tm) || (!searching && cfg.win && Math.abs(tm - now) > cfg.win * 60000)) continue;
      if (!searching && cfg.risk && levelOf(f.country) < 2) continue;
      const row = { f, tm };
      if (f.status === 'arrived' || tm < now) past.push(row);
      else up.push(row);
    }
    up.sort((a, b) => a.tm - b.tm);
    past.sort((a, b) => b.tm - a.tm);
    return { up, past };
  }

  // ---------------------------------------------------------------- render
  function renderControls() {
    const list = airports();
    if (data && list.length && !list.includes(cfg.airport)) cfg.airport = list[0];
    const opts = (list.length ? list : [cfg.airport]).map((code) => {
      const a = data?.airports?.[code];
      const name = a ? (isEn() ? a.name_en : a.name_zh) : code;
      const n = Number.isFinite(a?.flights) ? ` · ${a.flights}` : '';
      return `<option value="${esc(code)}"${code === cfg.airport ? ' selected' : ''}>${esc(name)} ${esc(code)}${esc(n)}</option>`;
    }).join('');
    if (selAirport.innerHTML !== opts) selAirport.innerHTML = opts;
    const cps = checkpoints();
    if (cfg.cp !== 'ALL' && cps.length && !cps.some((c) => c.id === cfg.cp)) cfg.cp = 'ALL';
    const btn = (id, label, aria) => `<button type="button" class="arr-cp${cfg.cp === id ? ' is-on' : ''}" data-cp="${esc(id)}" aria-pressed="${cfg.cp === id}"${aria ? ` aria-label="${esc(aria)}"` : ''}>${esc(label)}</button>`;
    cpsNode.innerHTML = cps.length
      ? btn('ALL', t('arr_cp_all')) + cps.map((c) => btn(c.id, t('arr_cp_label', { id: c.id, term: c.terminal }), t('arr_cp_aria', { id: c.id, term: c.terminal }))).join('')
      : '';
    cpsNode.hidden = !cps.length;
    if (winNode) {
      winNode.innerHTML = WINDOWS.map((w) => `<button type="button" class="arr-wbtn" data-win="${w}" aria-pressed="${cfg.win === w}">${
        esc(w ? t('arr_win_btn', { n: w }) : t('arr_win_all'))}</button>`).join('');
    }
    const kicker = root.querySelector('.arr-kicker [data-i18n="arr_kicker"]');
    if (kicker) kicker.textContent = cfg.win ? t('arr_kicker_n', { n: cfg.win }) : t('arr_kicker_all');
    const pageLink = root.querySelector('.arr-page'); // the full-screen page opens on the same airport / checkpoint / window
    if (pageLink) {
      pageLink.href = `arrivals.html?arr=${encodeURIComponent(cfg.airport)}${cfg.cp !== 'ALL' ? `-${encodeURIComponent(cfg.cp)}` : ''}&win=${cfg.win || 'all'}`;
    }
    btnBig.setAttribute('aria-pressed', String(!!cfg.big));
    renderScrollSwitch();
    root.classList.toggle('is-big', !!cfg.big);
  }

  function renderStatus(now) {
    if (status === 'loading' && !data) { statusNode.textContent = t('arr_loading'); statusNode.className = 'arr-status mono'; return; }
    if (!data) { statusNode.textContent = ''; return; }
    const gen = ts(data.tdx_updated || data.generated_at);
    const mins = Math.max(0, Math.round((now - gen) / 60000));
    const hour = Number(hm(now).slice(0, 2));
    const every = (hour < 5 ? data.refresh_minutes?.night : data.refresh_minutes?.day) || 10;
    const ago = t('arr_ago', { n: mins });
    const stale = mins > every * 2 + 5;
    statusNode.className = `arr-status mono${stale ? ' is-stale' : ''}`;
    const q = data.quota;
    statusNode.innerHTML = `<i class="pulse-dot" aria-hidden="true"></i><span>${esc(stale ? t('arr_stale', { ago }) : t('arr_updated', { time: hm(gen), ago }))}</span>${
      q?.cap_month ? `<span class="arr-quota">${esc(t('arr_quota', { used: q.calls_month ?? 0, cap: q.cap_month }))}</span>` : ''}`;
  }

  function diseasesFor(iso) {
    if (!iso) return [];
    const seen = new Set(); // groups are sorted by level: keep each disease once, at its highest level
    return groupAlerts(iso).filter((g) => !g.rows.every((r) => r.global) && !seen.has(g.disease) && seen.add(g.disease)).slice(0, 2);
  }

  function rowHtml({ f, tm }, now) {
    const iso = /^[A-Z]{2}$/.test(f.country || '') ? f.country : '';
    const lvl = iso ? levelOf(iso) : 0;
    const st = STATUSES.has(f.status) ? f.status : 'other';
    const mins = Math.round((tm - now) / 60000);
    const rel = mins >= 0 && st !== 'arrived' ? t('arr_in', { n: mins }) : t('arr_ago', { n: -mins });
    const sched = ts(f.scheduled);
    const shifted = Number.isFinite(sched) && Math.abs(sched - tm) >= 60000 && st !== 'cancelled';
    const city = (isEn() ? f.from_en : f.from_zh) || f.from_en || f.from || '';
    const cname = iso ? countryName(iso) : '';
    const cs = Array.isArray(f.codeshares) ? f.codeshares : [];
    const dis = diseasesFor(iso);
    const gate = (f.gate || '').trim();
    // baggage-claim carousel (TDX BaggageClaim, assigned before landing); meaningless for a cancelled flight
    const belt = st !== 'cancelled' && typeof f.carousel === 'string' && /^[0-9A-Z-]{1,4}$/.test(f.carousel) ? f.carousel : '';
    const statusText = st === 'other' ? ((isEn() ? f.status_en : f.status_zh) || t('arr_status_other')) : t(`arr_status_${st}`);
    const lvlBadge = lvl >= 2 ? badge(lvl, levelShort(lvl), 'badge-sm') : lvl === 1 ? `<span class="arr-l1 mono" title="${esc(levelShort(1))}"><i class="dot lvl-1"></i>L1</span>` : '';
    return `<li class="arr-row lvl-${lvl} st-${st}${f.id === hotId ? ' is-hot' : ''}" data-id="${esc(f.id)}">
      <button type="button" class="arr-hit"${iso ? ` data-iso="${esc(iso)}" aria-label="${esc(`${f.flight} ${city} ${hm(tm)} — ${t('arr_open_country', { name: cname })}`)}"` : ' disabled'}>
        <span class="arr-time"><b class="mono">${esc(hm(tm))}</b>${shifted ? `<s class="mono" title="${esc(t('arr_sched', { time: hm(sched) }))}">${esc(hm(sched))}</s>` : ''}<span class="arr-rel">${esc(rel)}</span></span>
        <span class="arr-main">
          <span class="arr-origin"><span class="arr-city">${esc(city)}</span><span class="arr-iata mono">${esc(f.from || '')}</span>${lvlBadge}</span>
          <span class="arr-sub"><span class="arr-country">${esc(cname)}</span><span class="arr-flight mono">${esc(f.flight || '')}</span>${
            cs.length ? `<span class="arr-cs mono" title="${esc(t('arr_codeshare_title', { list: cs.join(', ') }))}">${esc(t('arr_codeshare', { n: cs.length }))}</span>` : ''}${
            f.aircraft ? `<span class="arr-ac mono">${esc(f.aircraft)}</span>` : ''}</span>
          ${dis.length ? `<span class="arr-dis">${dis.map((g) => `<span class="arr-dz lvl-${levelNum(g.level)}"><i class="dot lvl-${levelNum(g.level)}"></i>${esc(diseaseName(g.disease))}</span>`).join('')}</span>` : ''}
        </span>
        <span class="arr-gate${gate ? '' : ' is-tbd'}"${gate ? '' : ` title="${esc(t('arr_gate_tbd_title'))}"`}>
          <b class="mono">${esc(gate || t('arr_gate_tbd'))}</b>
          <span class="mono">${f.terminal ? esc(t('arr_terminal', { term: f.terminal })) : ''}${f.checkpoint && cfg.cp === 'ALL' ? ` · ${esc(f.checkpoint)}` : ''}</span>
          ${belt ? `<span class="arr-belt" title="${esc(t('arr_carousel_title', { n: belt }))}">${esc(t('arr_carousel'))}<span class="arr-belt-n mono">${esc(belt)}</span></span>` : ''}
          <span class="arr-st st-${st}">${esc(statusText)}</span>
        </span>
      </button>
    </li>`;
  }

  function render() {
    if (!on) return;
    const now = Date.now();
    renderControls();
    renderStatus(now);
    if (!data) {
      const msg = status === 'none' ? t('arr_none') : status === 'error' ? t('arr_error') : t('arr_loading');
      body.innerHTML = `<p class="arr-empty">${esc(msg)}</p>`;
      layer.update([]);
      return;
    }
    const { up, past } = visible(now);
    const risky = [...up, ...past].filter(({ f }) => levelOf(f.country) >= 2).length;
    const winText = (dir) => (query.trim() ? t(`arr_window_${dir}_search`) : cfg.win ? t(`arr_window_${dir}`, { n: cfg.win }) : t(`arr_window_${dir}_all`));
    const section = (key, win, rows) => `<section class="arr-sec arr-sec-${key}">
        <h3><span>${esc(t(`arr_${key}`))}</span><small class="mono">${esc(winText(win))}</small><b class="mono">${rows.length}</b></h3>
        ${rows.length ? `<ol class="arr-list">${rows.map((r) => rowHtml(r, now)).join('')}</ol>` : ''}
      </section>`;
    const empty = !up.length && !past.length;
    const q = query.trim();
    body.innerHTML = `${q ? `<p class="arr-found mono">${esc(t('arr_find_count', { q, n: up.length + past.length }))}</p>` : ''}<p class="arr-summary"><span>${esc(t('arr_count', { up: up.length, past: past.length }))}</span>${
      risky || cfg.risk ? `<button type="button" class="arr-risk" data-risk aria-pressed="${!!cfg.risk}" title="${esc(t('arr_risk_title'))}">${
        esc(cfg.risk ? t('arr_risk_on', { n: risky }) : t('arr_risk', { n: risky }))}</button>` : ''}</p>${
      empty ? `<p class="arr-empty">${esc(q ? t('arr_find_none') : cfg.risk ? t('arr_empty_risk') : cfg.cp !== 'ALL' ? t('arr_empty_cp') : t('arr_empty'))}</p>` : ''}${
      section('upcoming', 'next', up)}${section('arrived', 'past', past)}`;
    layer.update([...up, ...past]);
  }

  // ---------------------------------------------------------------- map layer
  const layer = !map ? { update() {}, hot() {}, hide() {} } : (() => {
    const wrap = document.createElement('div');
    wrap.className = 'arr-layer';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML = '<svg class="arr-svg"><g class="zt"><g class="arr-arcs"></g><g class="arr-hub"></g><g class="arr-planes"></g></g></svg>';
    document.querySelector('#map')?.append(wrap);
    const svg = wrap.querySelector('svg');
    const zt = svg.querySelector('.zt');
    const gArcs = d3.select(svg.querySelector('.arr-arcs'));
    const gHub = d3.select(svg.querySelector('.arr-hub'));
    const gPlanes = d3.select(svg.querySelector('.arr-planes'));
    let rows = [];
    const geomCache = new Map();

    function geom(f, hub) {
      const key = `${f.from}|${hub.code}|${map.size().join('x')}`;
      if (geomCache.has(key)) return geomCache.get(key);
      const interp = d3.geoInterpolate([f.lon, f.lat], [hub.lon, hub.lat]);
      const proj = map.projection;
      const [w] = map.size();
      const N = 48;
      const pts = [];
      let d = '';
      let prev = null;
      for (let i = 0; i < N; i++) {
        const p = proj(interp(i / (N - 1)));
        pts.push(p);
        d += `${!prev || Math.abs(p[0] - prev[0]) > w * 0.4 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
        prev = p;
      }
      const km = d3.geoDistance([f.lon, f.lat], [hub.lon, hub.lat]) * 6371;
      const g = { d, pts, km };
      geomCache.set(key, g);
      return g;
    }

    function update(next = rows) {
      rows = next;
      const a = airportInfo();
      const show = on && a && Number.isFinite(a.lat) && Number.isFinite(a.lon) && !!map.size()[0];
      wrap.hidden = !show;
      if (!show) return;
      const hub = { code: cfg.airport, lat: a.lat, lon: a.lon };
      const now = Date.now();
      const [w, h] = map.size();
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      const valid = rows.filter(({ f }) => Number.isFinite(f.lat) && Number.isFinite(f.lon) && f.status !== 'cancelled');
      gArcs.selectAll('path').data(valid, ({ f }) => f.id).join('path')
        .attr('class', ({ f }) => `arr-arc lvl-${levelOf(f.country)}${f.id === hotId ? ' is-hot' : ''}${f.status === 'arrived' ? ' is-done' : ''}`)
        .attr('d', ({ f }) => geom(f, hub).d);
      const hp = map.projection([hub.lon, hub.lat]);
      gHub.selectAll('g').data([hub.code]).join((en) => {
        const g = en.append('g').attr('class', 'arr-hubmark');
        g.append('circle').attr('class', 'arr-hub-ring').attr('r', 12);
        g.append('circle').attr('class', 'arr-hub-dot').attr('r', 3.2);
        return g;
      }).attr('data-x', hp[0]).attr('data-y', hp[1]);
      // planes: arriving flights placed along their arc by remaining time (≈ 780 km/h + 25 min taxi/approach)
      const flying = valid.filter(({ f, tm }) => tm >= now && f.status !== 'arrived');
      gPlanes.selectAll('path').data(flying, ({ f }) => f.id).join('path')
        .attr('class', ({ f }) => `arr-plane lvl-${levelOf(f.country)}${f.id === hotId ? ' is-hot' : ''}`)
        .attr('d', PLANE)
        .each(function ({ f, tm }) {
          const g = geom(f, hub);
          const total = (g.km / 780) * 60 + 25;
          const left = (tm - now) / 60000;
          const u = clamp(1 - left / total, 0.04, 0.97);
          const i = Math.min(g.pts.length - 2, Math.floor(u * (g.pts.length - 1)));
          const [x0, y0] = g.pts[i];
          const [x1, y1] = g.pts[i + 1];
          const ang = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI + 90;
          this.dataset.x = x0;
          this.dataset.y = y0;
          this.dataset.a = ang;
        });
      scale();
    }

    function scale() {
      const tr = map.transform();
      zt.setAttribute('transform', tr.toString());
      const k = tr.k;
      gHub.selectAll('g').attr('transform', function () { return `translate(${this.dataset.x},${this.dataset.y}) scale(${1 / k})`; });
      gPlanes.selectAll('path').attr('transform', function () {
        return `translate(${this.dataset.x},${this.dataset.y}) rotate(${this.dataset.a}) scale(${(cfg.big ? 1.9 : 1.5) / k})`;
      });
    }

    function hot(id) {
      gArcs.selectAll('path').classed('is-hot', ({ f }) => f.id === id);
      gPlanes.selectAll('path').classed('is-hot', ({ f }) => f.id === id);
      if (id) gArcs.selectAll('path.is-hot').raise();
    }

    map.onZoom(scale);
    map.onResize(() => { geomCache.clear(); update(); });
    return { update, hot, hide: () => { wrap.hidden = true; } };
  })();

  // ---------------------------------------------------------------- interactions
  function setOn(v, { persist = true } = {}) {
    on = !!v;
    if (persist) storageSet(ON_KEY, on ? 'on' : 'off');
    button?.setAttribute('aria-pressed', String(on));
    root.hidden = !on;
    measureTop();
    applyLayout();
    if (on) { startPolling(); render(); startGlide(); } else { stopPolling(); stopGlide(); layer.hide(); }
    emit(on ? 'arrivals:open' : 'arrivals:close');
    onLayout?.();
  }
  const saveCfg = () => storageSet(CFG_KEY, JSON.stringify(cfg));

  button?.addEventListener('click', () => setOn(!on));
  btnClose?.addEventListener('click', () => { setOn(false); button?.focus(); });
  btnBig.addEventListener('click', () => { cfg.big = !cfg.big; saveCfg(); render(); });
  // other names of the origin airports (js/places.js): loaded the first time the search is used, never at page load
  let placesAsked = false;
  const warmPlaces = () => {
    if (placesAsked) return;
    placesAsked = true;
    loadPlaces().then(() => { if (query.trim()) render(); }).catch(() => {});
  };
  qInput?.addEventListener('focus', warmPlaces);
  qInput?.addEventListener('input', () => {
    warmPlaces();
    query = qInput.value;
    holdGlide(); // someone is typing: keep the list still and at the top
    body.scrollTop = 0;
    render();
  });
  qInput?.addEventListener('keydown', (e) => { if (e.key === 'Escape' && qInput.value) { e.stopPropagation(); qInput.value = ''; query = ''; render(); } });
  swScroll?.addEventListener('click', () => { cfg.scroll = !cfg.scroll; saveCfg(); renderScrollSwitch(); glide.holdUntil = 0; });
  btnMin?.addEventListener('click', () => {
    minimized = !minimized;
    root.classList.toggle('is-min', minimized);
    btnMin.setAttribute('aria-expanded', String(!minimized));
    const k = minimized ? 'arr_max_title' : 'arr_min_title';
    btnMin.title = t(k);
    btnMin.setAttribute('aria-label', t(k));
    applyLayout();
    onLayout?.();
  });
  btnDock?.addEventListener('click', () => {
    delete positions[mode()];
    storageSet(POS_KEY, JSON.stringify(positions));
    applyLayout();
    onLayout?.();
  });
  const toTop = () => { body.scrollTop = 0; glide.pos = 0; glide.phase = 'rest-top'; glide.until = performance.now() + REST_TOP_MS; };
  selAirport.addEventListener('change', () => { cfg.airport = selAirport.value; cfg.cp = 'ALL'; saveCfg(); hotId = null; render(); toTop(); });
  cpsNode.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cp]');
    if (!b) return;
    cfg.cp = b.dataset.cp;
    saveCfg();
    render();
    toTop();
  });
  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-risk]')) {
      cfg.risk = !cfg.risk;
      saveCfg();
      render();
      toTop();
      body.querySelector('[data-risk]')?.focus();
      return;
    }
    const b = e.target.closest('.arr-hit[data-iso]');
    if (b) openCountry(b.dataset.iso);
  });
  winNode?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-win]');
    if (!b) return;
    cfg.win = Number(b.dataset.win);
    saveCfg();
    render();
    toTop();
    winNode.querySelector(`[data-win="${cfg.win}"]`)?.focus();
  });
  const setHot = (id) => {
    if (id === hotId) return;
    hotId = id;
    root.querySelectorAll('.arr-row.is-hot').forEach((n) => n.classList.remove('is-hot'));
    if (id) root.querySelector(`.arr-row[data-id="${CSS.escape(id)}"]`)?.classList.add('is-hot');
    layer.hot(id);
  };
  body.addEventListener('pointerover', (e) => setHot(e.target.closest('.arr-row')?.dataset.id || null));
  body.addEventListener('pointerleave', () => setHot(null));
  body.addEventListener('focusin', (e) => setHot(e.target.closest('.arr-row')?.dataset.id || null));

  // drag the title bar to float the board (position remembered per orientation)
  head.addEventListener('pointerdown', (e) => {
    if (standalone || e.button !== 0 || mode() === 'phone' || e.target.closest('button, select, a')) return;
    const r = root.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const m = mode();
    const wasDocked = !positions[m];
    let moved = false;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      moved = true;
      positions[m] = { ...(positions[m] || {}), x: ev.clientX - dx, y: ev.clientY - dy, w: r.width, h: positions[m]?.h || r.height };
      applyLayout();
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      if (!moved) return;
      storageSet(POS_KEY, JSON.stringify(positions));
      if (wasDocked) onLayout?.(); // the map gets its space back
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
  // floating boards can be resized (CSS resize); remember the size
  if ('ResizeObserver' in window) {
    const save = debounce(() => {
      const m = mode();
      if (!floating() || minimized || root.hidden) return;
      const r = root.getBoundingClientRect();
      if (Math.abs(r.width - (positions[m].w || 0)) < 2 && Math.abs(r.height - (positions[m].h || 0)) < 2) return;
      positions[m] = { ...positions[m], w: Math.round(r.width), h: Math.round(r.height) };
      storageSet(POS_KEY, JSON.stringify(positions));
    }, 300);
    new ResizeObserver(save).observe(root);
  }

  function resize() {
    if (!on) return;
    measureTop();
    applyLayout();
  }

  function init() {
    root.classList.toggle('no-motion', reducedMotion());
    if (standalone) root.classList.add('is-standalone');
    if (on) setOn(true, { persist: !url && !standalone });
    else button?.setAttribute('aria-pressed', 'false');
  }

  return {
    init,
    resize,
    insets,
    refresh: () => { if (on) render(); },
    isOn: () => on,
    debug: { data: () => data, cfg: () => ({ ...cfg }), visible: () => visible(), setOn },
  };
}
