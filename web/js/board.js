// arrivals.html: the inbound flights board on its own page (tablets and screens at the quarantine counters).
// Same board as the map page (js/arrivals.js, standalone mode): no map, so it only needs alerts.json (origin
// levels) and countries.json (names) besides data/arrivals.json. A row opens the destination card on trip.html.
import { state } from './state.js';
import { setLang, t, applyStatic, bindData, getLang } from './i18n.js';
import { $, storageGet, storageSet } from './util.js';
import { bindTextSize } from './textsize.js';
import { startClock } from './hud.js';
import { createArrivals } from './arrivals.js';
import { autoReload } from './autoreload.js';

// js/boot-guard.js: this module and all its imports loaded and linked (no half-updated cache)
document.documentElement.dataset.booted = '1';

const LANG_KEY = 'safetravel.lang';
const THEME_KEY = 'safetravel.theme';

async function getJSON(file) {
  const res = await fetch(`data/${file}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.json();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('[data-testid="theme-toggle"]');
  btn.setAttribute('aria-label', t(theme === 'dark' ? 'theme_toggle_label_dark' : 'theme_toggle_label_light'));
  btn.title = btn.getAttribute('aria-label');
  btn.setAttribute('aria-pressed', String(theme === 'light'));
}

async function main() {
  setLang(storageGet(LANG_KEY) === 'en' ? 'en' : 'zh-Hant');
  bindData(state.data);
  applyStatic();
  document.title = `${t('board_title')} · SafeTravel TW`;
  document.documentElement.classList.remove('i18n-pending');
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const clockTick = startClock($('#clock'));
  // the board starts right under the header, whose height depends on the text size and wrapping
  const head = $('.board-head');
  const syncTop = () => document.documentElement.style.setProperty('--board-top', `${Math.ceil(head.getBoundingClientRect().height)}px`);
  if ('ResizeObserver' in window) new ResizeObserver(syncTop).observe(head);
  syncTop();
  const textSize = bindTextSize($('[data-testid="textsize-toggle"]'), { t });

  // origin levels and names; the board still works (no levels) if they fail
  const [alerts, countries] = await Promise.all([getJSON('alerts.json').catch(() => null), getJSON('countries.json').catch(() => null)]);
  state.data.alerts = alerts;
  state.data.countries = countries;

  const board = createArrivals({
    root: $('#arrivals'),
    button: null,
    map: null,
    standalone: true,
    openCountry: (iso) => { location.href = `trip.html#${encodeURIComponent(iso)}`; },
  });
  board.init();
  window.__safetravel = { state, arrivals: board.debug };

  $('[data-testid="lang-toggle"]').addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'zh-Hant' : 'en');
    storageSet(LANG_KEY, getLang() === 'en' ? 'en' : 'zh-Hant');
    applyStatic();
    document.title = `${t('board_title')} · SafeTravel TW`;
    applyTheme(document.documentElement.dataset.theme);
    textSize.refresh();
    clockTick();
    board.refresh();
  });
  $('[data-testid="theme-toggle"]').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    storageSet(THEME_KEY, next);
    applyTheme(next);
  });
  autoReload({ idleMs: 60_000 }); // kiosks: pick up new site code at a quiet moment
  document.body.dataset.ready = '1';
}

main();
