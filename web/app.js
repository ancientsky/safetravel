// SafeTravel TW — entry point. Loads data, wires the map, flights, panel, spotlight and HUD.
import {
  state, on, emit, levelOf,
  mofaMode, HUB_ORDER, availableHubs, hubData,
} from './js/state.js';
import { setLang, t, applyStatic, bindData, getLang, fmtNum, fmtDay } from './js/i18n.js';
import { $, esc, debounce, storageGet, storageSet, parseDay, todayTaipei, urlLang, syncUrlLang } from './js/util.js';
import { toast } from './js/toast.js';
import { bindTextSize } from './js/textsize.js';
import { startRefresh } from './js/refresh.js';
import { createSound } from './js/sound.js';
import { initTooltip } from './js/tooltip.js';
import { createMap } from './js/map.js';
import { createFlights } from './js/flights.js';
import { createPanel } from './js/panel.js';
import { makeFloatable } from './js/floatable.js';
import { createSpotlight } from './js/spotlight.js';
import { createArrivals } from './js/arrivals.js';
import { createWatch } from './js/watch.js';
import { createSearch, renderLayerSwitch } from './js/search.js';
import {
  startClock, renderTiles, renderFreshness, renderLegend, renderFlightHud, setLegendExtra, setLegendWatch, legendDocked,
} from './js/hud.js';

// js/boot-guard.js: this module and all its imports loaded and linked (no half-updated cache)
document.documentElement.dataset.booted = '1';

const LANG_KEY = 'safetravel.lang';
const THEME_KEY = 'safetravel.theme';
const FLIGHTS_KEY = 'safetravel.flights';
const FLIGHT_DIR_KEY = 'safetravel.flightdir'; // 'in' (default) | 'both'
const HUBS_KEY = 'safetravel.hubs'; // airports whose routes are on the map, e.g. "TPE,KHH" (default Taoyuan only)
/** "TPE,KHH" → ['TPE', 'KHH'] (known codes, map order); null when nothing valid. */
function parseHubs(v) {
  const want = String(v || '').toUpperCase().split(/[\s,;|]+/);
  const list = HUB_ORDER.filter((c) => want.includes(c));
  return list.length ? list : null;
}
const LEGEND_KEY = 'safetravel.legend'; // 'min' when collapsed
const PROMO_KEY = 'safetravel.mpromo'; // 'off' once the phone suggestion of m.html was used or dismissed
const LAYER_KEY = 'safetravel.layer';
const WX_KEY = 'safetravel.weather';

/** Initial map layer: ?layer=mofa|cdc deep link, else the stored choice, else CDC. */
function initialLayer() {
  const q = new URLSearchParams(location.search).get('layer');
  if (q === 'mofa' || q === 'cdc') return q;
  return storageGet(LAYER_KEY) === 'mofa' ? 'mofa' : 'cdc';
}

/** Weather overlay (default off): ?wx=1|0 deep link, else the stored choice. */
function initialWeather() {
  const q = new URLSearchParams(location.search).get('wx');
  if (q === '1' || q === '0') return q === '1';
  return storageGet(WX_KEY) === 'on';
}

/** epidemics.json via a worker (parse off the main thread, items streamed in batches). */
function loadEpidemicsData() {
  if (typeof Worker !== 'function') return getJSON('epidemics.json');
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker('js/epidemics-worker.js');
    } catch {
      getJSON('epidemics.json').then(resolve, reject);
      return;
    }
    let data = null;
    worker.onmessage = ({ data: msg }) => {
      if (msg.type === 'meta') {
        data = { ...msg.rest, items: [], overviews: {} };
      } else if (msg.type === 'overviews') {
        for (const [iso, ov] of msg.overviews) data.overviews[iso] = ov;
      } else if (msg.type === 'items') {
        data.items.push(...msg.items);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(data);
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (ev) => { // e.g. worker blocked: fall back to the main thread
      ev.preventDefault?.();
      worker.terminate();
      getJSON('epidemics.json').then(resolve, reject);
    };
    worker.postMessage({ url: new URL('data/epidemics.json', document.baseURI).href });
  });
}

async function getJSON(file) {
  const res = await fetch(`data/${file}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.json();
}

/** Resolve after the next frame has been rendered (layout is clean, nothing is pending). */
const afterPaint = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));
const whenIdle = (fn, timeout) => ('requestIdleCallback' in window
  ? requestIdleCallback(fn, { timeout })
  : setTimeout(fn, 300));

// Phones and low-core machines get the simplified 110m map (fewer, lighter paths).
// Simplified 110m geometry only on phone-width screens: the demo display keeps the detailed map
// (small advisory countries such as HK/SG/MO exist only in the 50m geometry) even on 4-core PCs,
// which instead get the lighter animation settings in flights.js.
const LITE_MAP = typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;

function initialTheme() {
  const stored = storageGet(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return 'dark'; // dark is the product default; users opt into light via the toggle
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  const btn = $('[data-testid="theme-toggle"]');
  if (btn) {
    btn.setAttribute('aria-label', t(theme === 'dark' ? 'theme_toggle_label_dark' : 'theme_toggle_label_light'));
    btn.title = btn.getAttribute('aria-label');
    btn.setAttribute('aria-pressed', String(theme === 'light'));
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#050a07' : '#fdf8e1';
}

function indexEpidemics(ep) {
  const cutoff = todayTaipei();
  if (cutoff) cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2);
  const by = new Map();
  for (const it of ep.items || []) {
    const d = parseDay(it.date);
    if (cutoff && d && d < cutoff) continue;
    for (const c of it.countries || []) {
      if (!by.has(c)) by.set(c, []);
      by.get(c).push(it);
    }
  }
  for (const list of by.values()) list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  state.byCountry = by;
}

let syncHudNow = () => {};

async function main() {
  state.lang = setLang(urlLang() || (storageGet(LANG_KEY) === 'en' ? 'en' : 'zh-Hant'));
  applyTheme(initialTheme());
  state.flightsOn = storageGet(FLIGHTS_KEY) !== 'off';
  const qRoutes = new URLSearchParams(location.search).get('routes'); // ?routes=in|both pins it (kiosks)
  state.flightDir = (qRoutes === 'both' || qRoutes === 'in' ? qRoutes : storageGet(FLIGHT_DIR_KEY)) === 'both' ? 'both' : 'in';
  // ?hubs=TPE,KHH pins the airports for a kiosk (not stored); otherwise this screen's last choice; Taoyuan by default
  state.hubs = parseHubs(new URLSearchParams(location.search).get('hubs')) || parseHubs(storageGet(HUBS_KEY)) || ['TPE'];
  state.legendMin = storageGet(LEGEND_KEY) === 'min';
  document.documentElement.dataset.flightdir = state.flightDir;
  state.layer = initialLayer();
  state.weather = { on: initialWeather(), status: 'idle', data: null, day: 0 };
  bindData(state.data);
  applyStatic();
  document.documentElement.classList.remove('i18n-pending'); // see the inline script in index.html
  initTooltip($('#tooltip'));
  // Overlays sit above the footer; keep --foot-h in sync with its real (wrapped) height.
  // The ResizeObserver reports the size after layout, so there is no forced synchronous reflow.
  const foot = $('.foot');
  if ('ResizeObserver' in window) {
    new ResizeObserver(([entry]) => {
      const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      document.documentElement.style.setProperty('--foot-h', `${Math.ceil(h)}px`);
    }).observe(foot);
  }
  // The toolbar, country panel, zoom buttons and weather bar sit just below the header, whose height depends on the
  // text size and on how its rows wrap: keep --hud-top-b (bottom of the title row) and --hud-b (bottom of the stat
  // tiles) in sync. Read inside the ResizeObserver callback, where layout is already up to date.
  const hudTop = $('.hud-top');
  const tilesNode = $('#stat-tiles');
  if ('ResizeObserver' in window && hudTop && tilesNode) {
    const syncHud = () => {
      // the tiles are filled in once the data has arrived: until then the CSS fallbacks (the 100 % layout) hold, so
      // the toolbar does not hop up to an empty tile row and back down again (layout shift)
      if (!tilesNode.children.length) return;
      const root = document.documentElement.style;
      root.setProperty('--hud-top-b', `${Math.round(hudTop.getBoundingClientRect().bottom)}px`);
      // phones hide the tiles (the legend strip carries the counts): the toolbar then follows the title row
      const tilesShown = tilesNode.getClientRects().length > 0;
      root.setProperty('--hud-b', `${Math.round((tilesShown ? tilesNode : hudTop).getBoundingClientRect().bottom)}px`);
    };
    const ro = new ResizeObserver(syncHud);
    ro.observe(hudTop);
    ro.observe(tilesNode);
    syncHudNow = syncHud;
  }
  const clockTick = startClock($('#clock'));

  // Synthesised sound effects (OFF by default; nothing is created until switched on).
  const sound = createSound({ button: $('[data-testid="sound-toggle"]') });
  on('spotlight:move', (iso) => sound.play('ping', levelOf(iso)));
  on('panel:open', () => sound.play('chime'));
  on('panel:close', () => sound.play('whoosh'));
  on('map:hover', (iso) => { if (iso && levelOf(iso) > 0) sound.play('tick'); });
  on('flight:landing', (x) => sound.landing(x));
  on('refresh:pending', () => sound.play('arpeggio'));
  // tiny click for the UI toggles (language, theme, filters, routes, spotlight switches)
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-testid="lang-toggle"], [data-testid="theme-toggle"], .lg-filter, .lg-all, .lg-min, .fh-dir button, .fh-toggle, .switch, .arr-toggle, .arr-cp, .arr-big, .watch-toggle, .wx-toggle, .wxb-day, .wxb-play')) sound.play('click');
  });

  // MOFA/MAC travel warnings: not critical (the map works without them); fetched alongside.
  const warningsP = getJSON('warnings.json').then((w) => { state.data.warnings = w; }, (err) => {
    state.errors.push(String(err?.message || err));
    if (state.layer === 'mofa') toast(t('error_load', { file: 'warnings.json' }));
  });

  // ---- critical data first ----
  const worldFile = LITE_MAP ? 'world-110m.json' : 'world.json';
  const files = [worldFile, 'alerts.json', 'meta.json', 'countries.json', 'flights.json'];
  const keys = ['world', 'alerts', 'meta', 'countries', 'flights'];
  const settled = await Promise.allSettled(files.map((f) => (f === 'world-110m.json'
    ? getJSON(f).catch(() => getJSON('world.json')) // simplified map missing: fall back to the full one
    : getJSON(f))));
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') state.data[keys[i]] = r.value;
    else {
      state.errors.push(String(r.reason?.message || r.reason));
      if (keys[i] !== 'world') toast(t('error_load', { file: files[i] }));
    }
  });

  const mapRoot = $('#map');
  let arrivals = null;
  const getInsets = () => {
    if (window.innerWidth >= 760) return arrivals?.insets() || null;
    const bottomOf = (sel) => document.querySelector(sel)?.getBoundingClientRect().bottom || 0;
    const top = Math.max(bottomOf('.toolbar'), bottomOf('.legend'), bottomOf('.flight-hud'), bottomOf('.wx-bar:not([hidden])')) + 8;
    const spot = document.querySelector('#spotlight')?.getBoundingClientRect().top || window.innerHeight;
    return { top, bottom: window.innerHeight - spot + 8 };
  };
  const map = createMap({ svgEl: $('#map-svg'), onOpen: (iso) => openCountry(iso), getInsets });
  const panel = createPanel({ root: $('#panel'), map });
  // the country panel can be dragged off its dock (and resized), like the arrivals board; the dock button returns it
  makeFloatable({ root: $('#panel'), handles: '.panel-head, .panel-autobar', key: 'safetravel.panel.pos', dockBtn: $('.panel-dock') });
  let flights = null;
  let spotlight = null;

  // Manual opens (map click, search, deep link, test API) count as user interaction for the spotlight.
  function openCountry(iso, opts) {
    emit('user:interact');
    return panel.open(iso, opts);
  }

  window.__safetravel = {
    state, openCountry, closePanel: () => panel.close(), sound: sound.debug,
  };

  // HUD first so the map can fit around the overlays.
  renderTiles($('#stat-tiles'), { animate: true });
  syncHudNow(); // phones hide the tiles, so no resize is reported once they are filled
  renderFreshness($('#freshness'));
  // Legend + flight HUD are laid out now (the map fits around them) but stay invisible until the arrivals
  // board has applied its docking: an open board pushes them sideways, which would count as layout shift.
  $('#legend').classList.add('is-held');
  $('#flight-hud').classList.add('is-held');
  renderLegend($('#legend'));
  renderFlightHud($('#flight-hud'));
  const layerNode = $('#layer-switch');
  const legendNode = $('#legend');
  // a left-docked arrivals board collapses the legend (and shrinks the route box, CSS): re-render when it docks / undocks
  let wasDocked = legendDocked();
  new MutationObserver(() => {
    const d = legendDocked();
    if (d === wasDocked) return;
    wasDocked = d;
    state.legendDockOpen = false;
    renderLegend(legendNode);
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  // portrait screens stack the route box on top of the legend: keep --legend-h (its height) current
  if ('ResizeObserver' in window) {
    new ResizeObserver(([e]) => {
      const h = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height;
      document.documentElement.style.setProperty('--legend-h', `${Math.ceil(h)}px`);
    }).observe(legendNode);
  }
  const onFilter = () => {
    map.applyFilter();
    renderLegend(legendNode);
  };
  // The legend is also the level filter (one place instead of tiles + chips + legend): tap a level to show only it.
  legendNode.addEventListener('click', (e) => {
    if (e.target.closest('[data-legend-min]')) {
      if (legendDocked()) state.legendDockOpen = !state.legendDockOpen; // beside a docked board: just for now
      else {
        state.legendMin = !state.legendMin;
        storageSet(LEGEND_KEY, state.legendMin ? 'min' : 'open');
      }
      renderLegend(legendNode);
      legendNode.querySelector('[data-legend-min]')?.focus();
      return;
    }
    const b = e.target.closest('[data-level]');
    if (!b) return;
    const set = mofaMode() ? state.wfilter : state.filter;
    const all = mofaMode() ? 4 : 3;
    const v = b.dataset.level;
    if (v === 'all') set.clear();
    else {
      const l = +v;
      if (set.has(l)) set.delete(l); else set.add(l);
      if (set.size === all) set.clear();
    }
    onFilter();
    legendNode.querySelector(`[data-level="${v}"]`)?.focus() || legendNode.querySelector('[data-level]')?.focus();
  });
  // Layer switch (CDC health advisories ↔ MOFA/MAC travel warnings): re-colours map, chips, legend, panel.
  let search = null;
  const applyLayer = () => {
    document.documentElement.dataset.layer = state.layer;
    renderLayerSwitch(layerNode, setLayer);
    renderLegend($('#legend'));
    if (state.data.world) map.applyLayer();
    search?.refresh();
    panel.refresh();
  };
  function setLayer(layer) {
    state.layer = layer === 'mofa' ? 'mofa' : 'cdc';
    storageSet(LAYER_KEY, state.layer);
    const u = new URL(location.href);
    if (u.searchParams.has('layer')) { // keep a shared ?layer= link in sync with the switch
      u.searchParams.set('layer', state.layer);
      history.replaceState(null, '', u);
    }
    applyLayer();
  }
  renderLayerSwitch(layerNode, setLayer);
  window.__safetravel.setLayer = setLayer;

  // Weather overlay (CWA world-city forecast): OFF by default. Its module and weather.json are only fetched the
  // first time it is switched on (or after the first map render when it starts on).
  const wxButton = $('[data-testid="weather-toggle"]');
  let wxOverlay = null;
  let wxModule = null;
  let mapReady = false;
  const renderWxToggle = () => wxButton.setAttribute('aria-pressed', String(state.weather.on));
  const wxChanged = () => {
    renderLegend($('#legend'));
    panel.refresh();
    if (window.innerWidth < 760) relayoutSoon(); // phones: the day bar changes the free band above the map
  };
  function loadWxOverlay() {
    wxModule ||= import('./js/weather.js').then((m) => {
      setLegendExtra(m.legendHtml);
      wxOverlay = m.createWeatherOverlay({
        map, mapRoot, bar: $('#wx-bar'), openCountry: (iso) => openCountry(iso), onChange: wxChanged,
      });
      panel.setWeather(wxOverlay.panelProvider);
      return wxOverlay;
    });
    return wxModule;
  }
  function setWeather(v) {
    state.weather.on = !!v;
    storageSet(WX_KEY, state.weather.on ? 'on' : 'off');
    const u = new URL(location.href);
    if (u.searchParams.has('wx')) { // keep a shared ?wx= link in sync with the toggle
      u.searchParams.set('wx', state.weather.on ? '1' : '0');
      history.replaceState(null, '', u);
    }
    renderWxToggle();
    if (!mapReady) return; // applied after the first map render
    if (state.weather.on) loadWxOverlay().then((o) => o.setOn(true)).catch((err) => { state.errors.push(String(err)); });
    else wxOverlay?.setOn(false);
    wxChanged();
  }
  renderWxToggle();
  wxButton.addEventListener('click', () => setWeather(!state.weather.on));
  window.__safetravel.weather = {
    isOn: () => state.weather.on, set: setWeather, status: () => state.weather.status,
    day: (i) => wxOverlay?.debug.setDay(i),
  };

  // Let the HUD paint first; the map (one long d3 task) renders in the next frame on clean layout.
  await afterPaint();

  if (!state.data.world) {
    mapRoot.classList.add('map-error');
    $('#map-error').hidden = false;
    $('#map-error').textContent = t('error_map');
    toast(t('error_map'));
  } else {
    await map.init(); // sliced into short tasks (see map.js)
    mapRoot.classList.add('is-ready');
    renderLegend($('#legend')); // level-0 count needs the world geometries
  }

  search = createSearch({ root: $('#search'), onPick: (iso) => openCountry(iso) });

  // Inbound flights board for quarantine stations (off by default; ?arr=TPE-C deep link).
  const relayout = () => {
    if (!state.data.world) return;
    map.resize();
    if (panel.isOpen()) map.setSelected(panel.current());
  };
  let relayoutTimer = 0;
  function relayoutSoon() { clearTimeout(relayoutTimer); relayoutTimer = setTimeout(relayout, 60); }
  // The spotlight card steps aside while the country panel (docked or dragged) or the arrivals board is open: the
  // tour keeps running (map highlight; the panel itself with "show full details"), only the card is put away.
  function syncSpotCard() {
    $('#spotlight')?.classList.toggle('is-hidden', !!(panel?.isOpen() || arrivals?.isOn()));
  }
  on('arrivals:open', syncSpotCard);
  on('arrivals:close', syncSpotCard);
  arrivals = createArrivals({
    root: $('#arrivals'), button: $('[data-testid="arrivals-toggle"]'), map, openCountry, onLayout: relayout,
  });
  arrivals.init();
  panel.setBoard((iso) => { emit('user:interact'); arrivals.showCountry(iso); }); // "today's direct flights" → board
  syncSpotCard(); // a board restored on load
  $('#legend').classList.remove('is-held');
  $('#flight-hud').classList.remove('is-held');
  window.__safetravel.arrivals = arrivals.debug;

  // Outbreak route watch (e.g. Irkutsk direct flights): header menu, off by default; ?watch=irkutsk deep link.
  const watch = createWatch({ button: $('[data-testid="watch-toggle"]'), menu: $('#watch-menu'), map });
  setLegendWatch(watch.legendItems); // the dashed outbreak routes get a legend entry while they are on the map
  on('watch:change', (ids) => {
    renderLegend(legendNode);
    $('[data-testid="menu-toggle"]')?.classList.toggle('has-active', !!ids?.length); // the routes' button is in the menu
  });
  if (state.data.world) watch.init();
  window.__safetravel.watch = watch.debug;

  if (state.data.world) {
    mapReady = true;
    if (state.weather.on) setWeather(true);
  } else {
    wxButton.disabled = true;
  }

  // travel warnings arrive after (or with) the critical data: switch the layer on when they do
  warningsP.then(() => {
    if (state.data.warnings) applyLayer();
    else renderLayerSwitch(layerNode, setLayer); // keeps the MOFA button disabled with a note
  });

  if (state.data.world) {
    map.setDotsVisible(state.flightsOn);
    // Animations start only once the map has painted and the main thread is idle, so they don't
    // compete with the first render.
    requestAnimationFrame(() => whenIdle(() => {
      flights = createFlights({ canvas: $('#flights-canvas'), map });
      flights.init();
      flights.setEnabled(state.flightsOn && !!state.data.flights);
      whenIdle(() => { // separate task from the flight set-up
        spotlight = createSpotlight({ root: $('#spotlight'), map, panel });
        spotlight.start();
        window.__safetravel.spotlight = { next: (iso) => spotlight.next(iso), current: () => spotlight.current() };
      }, 1000);
    }, 1500));
  }

  // Phones: suggest the quick-check page (m.html) once; "no thanks" is remembered. Overlay, so nothing shifts.
  if (LITE_MAP && storageGet(PROMO_KEY) !== 'off' && !new URLSearchParams(location.search).has('arr')) {
    setTimeout(() => {
      const bar = document.createElement('div');
      bar.className = 'm-promo glass';
      bar.setAttribute('role', 'note');
      bar.dataset.testid = 'm-promo';
      const txt = document.createElement('span');
      txt.textContent = t('m_promo');
      const goLink = document.createElement('a');
      goLink.className = 'm-promo-go';
      goLink.href = 'm.html';
      goLink.textContent = t('m_promo_go');
      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'm-promo-no';
      no.textContent = t('m_promo_close');
      no.addEventListener('click', () => { storageSet(PROMO_KEY, 'off'); bar.remove(); });
      goLink.addEventListener('click', () => storageSet(PROMO_KEY, 'off'));
      bar.append(txt, goLink, no);
      document.body.append(bar);
    }, 2500);
  }

  // ---- controls ----
  const textSize = bindTextSize($('[data-testid="textsize-toggle"]'), { t });
  $('[data-testid="lang-toggle"]').addEventListener('click', () => {
    state.lang = setLang(getLang() === 'en' ? 'zh-Hant' : 'en');
    textSize.refresh();
    storageSet(LANG_KEY, state.lang);
    syncUrlLang(state.lang);
    applyStatic();
    sound.refresh();
    applyTheme(state.theme);
    clockTick();
    renderTiles($('#stat-tiles'));
    renderFreshness($('#freshness'));
    renderLegend($('#legend'));
    renderFlightHud($('#flight-hud'));
    renderLayerSwitch(layerNode, setLayer);
    map.relabel();
    search.refresh();
    panel.refresh();
    spotlight?.refresh();
    arrivals.refresh();
    watch.refresh();
    wxOverlay?.refresh();
  });
  $('[data-testid="theme-toggle"]').addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    storageSet(THEME_KEY, state.theme);
    flights?.refreshTheme();
  });
  $('.fh-toggle').addEventListener('click', () => {
    state.flightsOn = !state.flightsOn;
    storageSet(FLIGHTS_KEY, state.flightsOn ? 'on' : 'off');
    flights?.setEnabled(state.flightsOn);
    map.setDotsVisible(state.flightsOn);
    renderFlightHud($('#flight-hud'));
    renderLegend(legendNode);
  });
  // route direction: arrivals only (default, what quarantine watches) or both directions
  $('#flight-hud').addEventListener('click', (e) => {
    const b = e.target.closest('.fh-dir [data-dir]');
    if (!b || b.dataset.dir === state.flightDir) return;
    state.flightDir = b.dataset.dir === 'both' ? 'both' : 'in';
    storageSet(FLIGHT_DIR_KEY, state.flightDir);
    document.documentElement.dataset.flightdir = state.flightDir;
    flights?.setDirection(state.flightDir);
    renderFlightHud($('#flight-hud'));
    renderLegend(legendNode);
    $(`#flight-hud [data-dir="${state.flightDir}"]`)?.focus();
  });
  // ---- phone menu (≤760 px): the site's other pages + this page's switches, labelled and with their state ----
  const pm = $('#phone-menu');
  const pmBtn = $('[data-testid="menu-toggle"]');
  const proxyOf = (b) => $(`[data-testid="${b.dataset.proxy}"]`);
  const KEEP_OPEN = new Set(['textsize-toggle', 'theme-toggle', 'lang-toggle', 'sound-toggle', 'spotlight-autoopen']);
  function pmRefresh() {
    pm.querySelectorAll('[data-proxy]').forEach((b) => {
      const src = proxyOf(b);
      const st = b.querySelector('.pm-state');
      if (!src || !st) return;
      let txt = '';
      let isOn = false;
      if (b.dataset.proxy === 'textsize-toggle') txt = t(`ts_${document.documentElement.dataset.ts || 'm'}`);
      else if (b.dataset.proxy === 'theme-toggle') txt = t(state.theme === 'dark' ? 'menu_dark' : 'menu_light');
      else if (b.dataset.proxy !== 'lang-toggle') {
        isOn = b.dataset.proxy === 'watch-toggle' ? src.classList.contains('is-active')
          : (src.getAttribute('aria-pressed') ?? src.getAttribute('aria-checked')) === 'true'; // buttons and switches
        txt = t(isOn ? 'menu_on' : 'menu_off');
      }
      st.textContent = txt;
      st.hidden = !txt;
      st.classList.toggle('is-on', isOn);
    });
  }
  function pmOpen(v) {
    pm.hidden = !v;
    pmBtn.setAttribute('aria-expanded', String(v));
    if (v) { pmRefresh(); pm.querySelector('.pm-item')?.focus(); } else pmBtn.focus();
  }
  pmBtn.addEventListener('click', () => pmOpen(true));
  pm.querySelector('.pm-close').addEventListener('click', () => pmOpen(false));
  pm.addEventListener('click', (e) => {
    if (e.target === pm) { pmOpen(false); return; } // tap outside the sheet
    const b = e.target.closest('[data-proxy]');
    if (!b) return;
    const keep = KEEP_OPEN.has(b.dataset.proxy);
    if (!keep) pmOpen(false); // the board and the outbreak-route menu need the screen
    proxyOf(b)?.click(); // runs the button's own handler right away
    if (keep) pmRefresh();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pm.hidden) { e.stopPropagation(); pmOpen(false); } }, true);

  // ---- airport routes (menu): Taoyuan by default; 松山 / 臺中 / 臺南 / 高雄 from flights.json `hubs` ----
  const hubList = $('.pm-hubs', pm);
  function renderHubMenu() {
    if (!hubList) return;
    const have = new Set(availableHubs());
    hubList.innerHTML = HUB_ORDER.map((code) => {
      const d = hubData(code);
      const isOn = state.hubs.includes(code) && have.has(code);
      const last = isOn && state.hubs.filter((c) => have.has(c)).length === 1;
      const today = todayTaipei()?.toISOString().slice(0, 10);
      const sub = d ? t('hub_menu_stats', { a: fmtNum(d.totals?.arrivals ?? 0), d: fmtNum(d.totals?.departures ?? 0), date: d.date === today ? '' : fmtDay(d.date, 'short') })
        : t('hub_menu_none');
      const site = d?.hub?.site && /^https:\/\//.test(d.hub.site) ? d.hub.site : '';
      return `<li class="pm-hub">
        <button type="button" class="pm-item" role="switch" aria-checked="${isOn}" data-hub="${code}"${d ? '' : ' aria-disabled="true"'}${last ? ` title="${esc(t('hub_menu_last'))}"` : ''}>
          <i class="hub-dot hub-${code.toLowerCase()}" aria-hidden="true"></i>
          <span class="pm-text"><b>${esc(t(`hub_${code}`))} ${code}</b><small>${esc(sub)}</small></span>
          <span class="pm-state${isOn ? ' is-on' : ''}">${esc(t(isOn ? 'menu_on' : 'menu_off'))}</span>
        </button>
        ${d ? `<div class="pm-hub-links"><button type="button" data-hub-board="${code}">${esc(t('hub_board'))} →</button>${site ? `<a href="${esc(site)}" target="_blank" rel="noopener noreferrer">${esc(t('hub_site'))} ↗</a>` : ''}</div>` : ''}
      </li>`;
    }).join('');
  }
  /** Switch an airport's routes on or off (and redraw the layer, dots, radar box and legend). */
  function setHub(code, v, { persist = true } = {}) {
    if (!hubData(code)) return;
    const next = new Set(state.hubs);
    if (v) next.add(code); else next.delete(code);
    const list = HUB_ORDER.filter((c) => next.has(c));
    if (!list.some((c) => hubData(c))) { toast(t('hub_menu_last')); return; } // keep at least one airport on the map
    if (list.join() === state.hubs.join()) return;
    state.hubs = list;
    if (persist) storageSet(HUBS_KEY, list.join(','));
    if (v && !state.flightsOn) $('.fh-toggle').click(); // switching an airport on means: show the routes
    flights?.setHubs();
    map.renderDots();
    renderFlightHud($('#flight-hud'));
    renderLegend(legendNode);
    renderHubMenu();
    emit('hubs:change', list);
  }
  hubList?.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-hub]');
    if (sw && sw.getAttribute('aria-disabled') !== 'true') {
      const code = sw.dataset.hub;
      setHub(code, !state.hubs.includes(code));
      hubList.querySelector(`[data-hub="${code}"]`)?.focus();
      return;
    }
    const b = e.target.closest('[data-hub-board]');
    if (b) { pmOpen(false); arrivals.showAirport(b.dataset.hubBoard); }
  });
  pmBtn.addEventListener('click', renderHubMenu);
  // the arrivals board and the route layer follow each other: picking an airport on the board shows its routes
  on('arrivals:airport', (code) => { if (hubData(code) && !state.hubs.includes(code)) setHub(code, true); });
  window.__safetravel.hubs = { set: setHub, list: () => [...state.hubs] };
  // a board opened on another airport (?arr=KHH, or restored) shows that airport's routes too, without storing it
  if (arrivals.isOn() && arrivals.airport() !== 'TPE') setHub(arrivals.airport(), true, { persist: false });

  $('#zoom-in').addEventListener('click', () => map.zoomBy(1.6));
  $('#zoom-out').addEventListener('click', () => map.zoomBy(1 / 1.6));
  $('#zoom-reset').addEventListener('click', () => map.reset());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.isOpen() && !search.isOpen()) {
      panel.close();
    } else if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
      e.preventDefault();
      $('#search-input').focus();
    }
  });

  window.addEventListener('resize', debounce(() => {
    arrivals.resize();
    map.resize();
    if (panel.isOpen()) map.setSelected(panel.current());
  }, 180));

  // keep the spotlight effect (outline + reticle) on the country whose panel is shown
  on('panel:open', (iso) => {
    syncSpotCard();
    map.setSpotlight(iso);
  });
  on('panel:close', syncSpotCard);

  // ---- deep links ----
  const fromHash = () => {
    const m = /^#\/country\/([A-Za-z]{2})$/.exec(location.hash);
    if (m) openCountry(m[1].toUpperCase());
    else if (!location.hash && panel.isOpen()) panel.close();
  };
  window.addEventListener('hashchange', fromHash);
  fromHash();

  setInterval(() => renderFreshness($('#freshness')), 60000);

  // Unattended kiosk use: pick up newly published data (reloads at a quiet moment).
  window.__safetravel.refresh = startRefresh({ generatedAt: state.data.meta?.generated_at });

  // ---- lazy: epidemics digest (~5 MB) ----
  state.epidemicsStatus = 'loading';
  const loadEpidemics = async () => {
    try {
      const ep = await loadEpidemicsData();
      await yieldToMain(); // keep parse, indexing and re-render in separate (short) tasks
      state.data.epidemics = ep;
      indexEpidemics(ep);
      state.epidemicsStatus = 'ready';
      await yieldToMain();
    } catch (err) {
      state.epidemicsStatus = 'error';
      state.errors.push(String(err?.message || err));
      toast(t('error_load', { file: 'epidemics.json' }));
    }
    document.body.classList.toggle('digests-ready', state.epidemicsStatus === 'ready');
    $('#digest-status').hidden = true;
    if (!state.data.meta) renderTiles($('#stat-tiles'));
    panel.refresh();
    await yieldToMain();
    spotlight?.refresh();
  };
  $('#digest-status').hidden = false;
  whenIdle(loadEpidemics, 2500);

}

main().catch((err) => {
  document.documentElement.classList.remove('i18n-pending');
  console.error(err);
  toast(String(err?.message || err));
});
