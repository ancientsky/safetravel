// SafeTravel TW — entry point. Loads data, wires the map, flights, panel, spotlight and HUD.
import { state, on, emit } from './js/state.js';
import { setLang, t, applyStatic, bindData, getLang } from './js/i18n.js';
import { $, debounce, storageGet, storageSet, parseDay, todayTaipei } from './js/util.js';
import { toast } from './js/toast.js';
import { startRefresh } from './js/refresh.js';
import { initTooltip } from './js/tooltip.js';
import { createMap } from './js/map.js';
import { createFlights } from './js/flights.js';
import { createPanel } from './js/panel.js';
import { createSpotlight } from './js/spotlight.js';
import { createSearch, renderFilterChips } from './js/search.js';
import {
  startClock, renderTiles, renderFreshness, renderLegend, renderFlightHud,
} from './js/hud.js';

const LANG_KEY = 'safetravel.lang';
const THEME_KEY = 'safetravel.theme';
const FLIGHTS_KEY = 'safetravel.flights';

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
        data = { ...msg.rest, items: [] };
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

async function main() {
  state.lang = setLang(storageGet(LANG_KEY) === 'en' ? 'en' : 'zh-Hant');
  applyTheme(initialTheme());
  state.flightsOn = storageGet(FLIGHTS_KEY) !== 'off';
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
  const clockTick = startClock($('#clock'));

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
  const getInsets = () => {
    if (window.innerWidth >= 760) return null;
    const bottomOf = (sel) => document.querySelector(sel)?.getBoundingClientRect().bottom || 0;
    const top = Math.max(bottomOf('.toolbar'), bottomOf('.legend'), bottomOf('.flight-hud')) + 8;
    const spot = document.querySelector('#spotlight')?.getBoundingClientRect().top || window.innerHeight;
    return { top, bottom: window.innerHeight - spot + 8 };
  };
  const map = createMap({ svgEl: $('#map-svg'), onOpen: (iso) => openCountry(iso), getInsets });
  const panel = createPanel({ root: $('#panel'), map });
  let flights = null;
  let spotlight = null;

  // Manual opens (map click, search, deep link, test API) count as user interaction for the spotlight.
  function openCountry(iso, opts) {
    emit('user:interact');
    return panel.open(iso, opts);
  }

  window.__safetravel = { state, openCountry, closePanel: () => panel.close() };

  // HUD first so the map can fit around the overlays.
  renderTiles($('#stat-tiles'), { animate: true });
  renderFreshness($('#freshness'));
  renderLegend($('#legend'));
  renderFlightHud($('#flight-hud'));
  const chipsNode = $('#level-chips');
  const onFilter = () => {
    map.applyFilter();
    renderFilterChips(chipsNode, onFilter);
  };
  renderFilterChips(chipsNode, onFilter);

  // Let the HUD paint first; the map (one long d3 task) renders in the next frame on clean layout.
  await afterPaint();

  if (!state.data.world) {
    mapRoot.classList.add('map-error');
    $('#map-error').hidden = false;
    $('#map-error').textContent = t('error_map');
    toast(t('error_map'));
  } else {
    map.init();
    mapRoot.classList.add('is-ready');
    renderLegend($('#legend')); // level-0 count needs the world geometries
  }

  const search = createSearch({ root: $('#search'), onPick: (iso) => openCountry(iso) });

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

  // ---- controls ----
  $('[data-testid="lang-toggle"]').addEventListener('click', () => {
    state.lang = setLang(getLang() === 'en' ? 'zh-Hant' : 'en');
    storageSet(LANG_KEY, state.lang);
    applyStatic();
    applyTheme(state.theme);
    clockTick();
    renderTiles($('#stat-tiles'));
    renderFreshness($('#freshness'));
    renderLegend($('#legend'));
    renderFlightHud($('#flight-hud'));
    renderFilterChips(chipsNode, onFilter);
    map.relabel();
    search.refresh();
    panel.refresh();
    spotlight?.refresh();
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
  });
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
    map.resize();
    if (panel.isOpen()) map.setSelected(panel.current());
  }, 180));

  on('panel:open', () => {
    $('#spotlight')?.classList.add('is-hidden');
    map.setSpotlight(null);
  });
  on('panel:close', () => $('#spotlight')?.classList.remove('is-hidden'));

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
