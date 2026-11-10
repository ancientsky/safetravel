// trip.html — 出國前旅遊安全查詢: MOFA/MAC travel warnings and Taiwan CDC travel health notices,
// side by side per destination (never merged into one score).
import { $, storageGet, storageSet, reducedMotion } from './util.js';
import {
  initLang, setLang, isEn, t, applyStatic, bindLevels, fmtStamp, fmtDay, mofaShort, cdcShort,
} from './trip-i18n.js';
import { getJSON, buildModel } from './trip-data.js';
import { h, extLink } from './trip-dom.js';
import { createMap } from './trip-map.js';
import { renderCard } from './trip-card.js';
import { createTable } from './trip-table.js';
import { renderChanges } from './trip-changes.js';
import { createSearch } from './trip-search.js';
import { createWeather, loadWeather } from './trip-weather.js';
import { createWxMap } from './trip-wxmap.js';
import { createClinics } from './trip-clinics.js';
import { initPhoneNav } from './trip-nav.js';
import { autoReload } from './autoreload.js';
import { bindTextSize } from './textsize.js';

// js/boot-guard.js: this module and all its imports loaded and linked (no half-updated cache)
document.documentElement.dataset.booted = '1';

const THEME_KEY = 'safetravel.trip.theme';
const TABS = ['mofa', 'cdc', 'wx'];
const root = document.documentElement;

const app = {
  model: buildModel({}),
  tab: 'mofa',
  map: null,
  wxmap: null,
  open: null,       // ISO of the open card
  returnFocus: null,
  notices: new Set(),
};

const cardEl = $('#card');
const mapBox = $('#map-box');
const table = createTable({ root: $('#all'), onOpen: (iso) => openCard(iso), onPrint: () => printPart('table') });
const search = createSearch({
  input: $('#q'), listEl: $('#q-list'), statusEl: $('#q-status'), onOpen: (iso) => openCard(iso),
});
const clinics = createClinics({ root: $('#clinics') });
const weather = createWeather({
  root: $('#weather'),
  onOpen: (iso) => openCard(iso),
  onSettled: () => { renderStamps(); feedWxMap(); },
  onUnit: () => { app.wxmap?.refresh(); if (app.tab === 'wx') renderLegend(); },
});

// ---------------- theme & language ----------------
function applyThemeButton() {
  const dark = root.dataset.theme === 'dark';
  const btn = $('.theme-toggle');
  btn.querySelector('.theme-text').textContent = dark ? t('theme_to_light') : t('theme_to_dark');
  btn.setAttribute('aria-label', dark ? t('theme_to_light_label') : t('theme_to_dark_label'));
  btn.title = btn.getAttribute('aria-label');
}
$('.theme-toggle').addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  storageSet(THEME_KEY, next);
  applyThemeButton();
});
const textSize = bindTextSize($('[data-testid="textsize-toggle"]'), { t });
$('.lang-toggle').addEventListener('click', () => {
  setLang(isEn() ? 'zh-Hant' : 'en');
  renderAll();
  textSize.refresh();
});

// ---------------- notices ----------------
function renderNotices() {
  $('#notices').replaceChildren(...[...app.notices].map((k) => h('p', { class: 'notice', text: t(k) })));
}
function notice(key) {
  app.notices.add(key);
  renderNotices();
}

// ---------------- header stamps & footer ----------------
function renderStamps() {
  const W = app.model.warnings;
  const A = app.model.alerts;
  const items = [
    [t('stamp_mofa'), W ? fmtStamp(W.sources?.mofa?.fetched_at) || fmtStamp(W.generated_at) : ''],
    [t('stamp_cdc'), A ? fmtStamp(A.generated_at) : ''],
    [t('stamp_mac'), fmtDay(W?.sources?.mac?.confirmed)],
  ];
  const wx = weather.stamp(); // null until weather.json has settled
  if (wx != null) items.push([t('stamp_cwa'), wx]);
  $('#stamps').replaceChildren(...items.map(([k, v]) => h('div', {},
    h('dt', { text: k }), h('dd', {}, v ? h('time', { text: v }) : t('stamp_unknown')))));

  const mac = W?.sources?.mac;
  $('.foot-mac').replaceChildren(extLink(mac?.url || 'https://www.mac.gov.tw/', t('foot_mac'), ''));
  const confirmed = fmtDay(mac?.confirmed);
  $('.foot-mac-note').textContent = confirmed ? t('foot_mac_note', { d: confirmed }) : t('foot_mac_note_nodate');
}

// ---------------- map ----------------
function renderLegend() {
  const list = app.model.list;
  const count = (fn) => list.filter(fn).length;
  const item = (cls, label, n) => h('li', {}, h('i', { class: `sw ${cls}`, 'aria-hidden': 'true' }), h('span', { text: label }),
    n != null ? h('span', { class: 'lg-n', text: String(n) }) : null);
  const items = [];
  if (app.tab === 'wx') {
    $('#legend').replaceChildren(...(app.wxmap && !weather.failed() ? app.wxmap.legendItems()
      : [h('li', { class: 'lg-note', text: weather.failed() ? t('wx_failed') : t('wxm_loading') })]));
    return;
  }
  if (app.tab === 'mofa') {
    for (const lv of [4, 3, 2, 1]) items.push(item(`m-${lv}`, `${lv} ${mofaShort(lv)}`, count((d) => d.w && d.mofa === lv)));
    items.push(item('m-0', t('legend_mofa_none'), count((d) => !d.w || !d.mofa)));
    items.push(item('sw-hatch', t('legend_partial'), count((d) => d.partial)));
  } else {
    for (const lv of [3, 2, 1]) items.push(item(`c-${lv}`, cdcShort(lv), count((d) => d.a && d.cdc === lv)));
    items.push(item('c-0', t('legend_cdc_none'), null));
  }
  items.push(item('sw-tw', t('legend_tw'), null));
  $('#legend').replaceChildren(...items);
}

function setTab(tab, focus = false) {
  app.tab = TABS.includes(tab) ? tab : 'mofa';
  mapBox.dataset.tab = app.tab;
  $('#map-sec').dataset.tab = app.tab;
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === app.tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  });
  $('#map-panel').setAttribute('aria-labelledby', `tab-${app.tab}`);
  $('#tmap').setAttribute('aria-label', t(`map_label_${app.tab}`));
  // the weather layer has focusable markers, which an role="img" would hide from assistive tech
  $('#tmap').setAttribute('role', app.tab === 'wx' ? 'group' : 'img');
  app.wxmap?.setActive(app.tab === 'wx');
  renderLegend();
}
document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => setTab(b.dataset.tab));
  b.addEventListener('keydown', (ev) => {
    const i = TABS.indexOf(app.tab);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[ev.key];
    if (to != null) {
      ev.preventDefault();
      setTab(TABS[(to + TABS.length) % TABS.length], true);
    }
  });
});

async function initMap() {
  const narrow = window.innerWidth < 760;
  try {
    const world = await getJSON(narrow ? 'data/world-110m.json' : 'data/world.json');
    app.map = createMap({ box: mapBox, svgEl: $('#tmap'), tipEl: $('#tip'), onOpen: (iso) => openCard(iso) });
    app.map.render(world, app.model);
    if (app.open) app.map.select(app.open);
    app.wxmap = createWxMap({
      map: app.map, box: mapBox, svgEl: $('#tmap'), tipEl: $('#tip'), barEl: $('.wxm-bar'), onOpen: (iso) => openCard(iso),
    });
    feedWxMap();
    setTab(app.tab);
    $('.z-in').addEventListener('click', () => app.map.zoomBy(1.6));
    $('.z-out').addEventListener('click', () => app.map.zoomBy(1 / 1.6));
    $('.z-reset').addEventListener('click', () => app.map.reset());
  } catch (err) {
    console.warn('trip: map unavailable', err);
    mapBox.classList.add('failed');
    notice('notice_no_map');
  }
}

/** Hand weather.json to the map layer once both have loaded (either may finish first). */
function feedWxMap() {
  const data = weather.data();
  if (app.tab === 'wx' && weather.failed()) renderLegend();
  if (!app.wxmap || !data || app.wxmap.hasData()) return;
  app.wxmap.setData(data, app.model);
  app.wxmap.setActive(app.tab === 'wx');
  if (app.tab === 'wx') renderLegend();
}

// ---------------- card ----------------
// The address carries the open destination as #ISO. Choosing one while no card is open adds a history entry, so the
// browser's Back closes the card instead of leaving the page; going from one destination to another replaces that
// entry. history.state remembers both ends: tripCard on the added entry (closing the card steps back from it) and
// tripHome on the entry it was added from (coming back to it closes the card, even when its address is a section
// anchor such as #all). Section chips stay ordinary anchors: tapping one with a card open leaves the card alone.
let backPending = false;  // closeCard() asked for history.back() and it has not landed yet
let pendingLanded = null; // what to do once it has

function writeHash(iso, hadCard) {
  if (location.hash === `#${iso}`) return;
  if (hadCard) { history.replaceState(history.state, '', `#${iso}`); return; }
  history.replaceState({ ...(history.state || {}), tripHome: 1, tripY: Math.round(window.scrollY) }, '');
  history.pushState({ tripCard: 1 }, '', `#${iso}`);
}

/** fromUrl: the address already names this destination (page load, Back / Forward, typed hash). */
function openCard(iso, { focus = true, scroll = true, fromUrl = false } = {}) {
  const d = app.model.dests.get(String(iso || '').toUpperCase());
  if (!d) return false;
  const hadCard = !!app.open;
  if (!hadCard) app.returnFocus = document.activeElement;
  // before the card is drawn: the entry being left keeps the scroll position the visitor chose from
  if (fromUrl) writeHash(d.iso, true); // only tidies the spelling (#jp → #JP)
  else if (!backPending) writeHash(d.iso, hadCard);
  app.open = d.iso;
  renderCard(cardEl, d, {
    model: app.model, onClose: closeCard, onPrint: () => printPart('card'), localWeather: weather.localSection,
    onClinics: () => { clinics.start(); clinics.focus(); },
  });
  cardEl.hidden = false;
  app.map?.select(d.iso);
  app.map?.hideTip();
  if (scroll) cardEl.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  if (focus) $('#card-title')?.focus({ preventScroll: true });
  return true;
}

/** fromUrl: Back / Forward already moved the address to an entry without a destination. */
function closeCard({ fromUrl = false } = {}) {
  cardEl.hidden = true;
  cardEl.replaceChildren();
  app.open = null;
  app.map?.select(null);
  const opener = app.returnFocus;
  app.returnFocus = null;
  const refocus = opener && opener.isConnected && opener !== document.body ? opener : null;
  if (fromUrl) {
    // a text field refocused after the visitor's own Back would bring up a phone's keyboard
    afterBack(refocus && !refocus.matches('input, select, textarea') ? refocus : null);
  } else if (history.state?.tripCard) {
    // this entry was added when the card opened: step back to the one before it, so entries do not pile up
    backPending = true;
    const landed = () => { if (!app.open) afterBack(refocus); };
    pendingLanded = landed;
    setTimeout(() => { if (backPending && pendingLanded === landed) syncFromUrl(); }, 1500);
    history.back();
  } else {
    history.replaceState(null, '', location.pathname + location.search);
    refocus?.focus({ preventScroll: false });
  }
}

/** The address is back on the entry the card was opened from: put the page where the visitor chose the destination. */
function afterBack(refocus) {
  const y = history.state?.tripY;
  // later, because an address with a section anchor makes the browser drop focus right after this event
  if (refocus) setTimeout(() => { if (!app.open && refocus.isConnected) refocus.focus({ preventScroll: true }); }, 0);
  // The browser's own restore is not enough here: for an entry with a section anchor it goes back to that section's
  // start, and a smooth scroll to the card that is still running delivers one more frame after it. Two frames later
  // both have happened.
  if (typeof y !== 'number') return;
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!app.open) window.scrollTo({ top: y, behavior: 'instant' }); }));
}

function syncFromUrl() {
  if (backPending) {
    backPending = false;
    const landed = pendingLanded;
    pendingLanded = null;
    if (app.open) {
      // a destination chosen before that Back landed gets its own entry now
      writeHash(app.open, false);
      cardEl.scrollIntoView({ behavior: 'auto', block: 'start' });
    } else landed?.();
    return;
  }
  const iso = location.hash.slice(1).toUpperCase();
  if (app.model.dests.has(iso)) {
    if (iso !== app.open) openCard(iso, { fromUrl: true });
  } else if (app.open && (!location.hash || history.state?.tripHome)) closeCard({ fromUrl: true });
}
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && app.open && cardEl.contains(document.activeElement)) closeCard();
});
window.addEventListener('hashchange', syncFromUrl);
window.addEventListener('popstate', syncFromUrl);

// ---------------- print ----------------
function printPart(part) {
  document.body.classList.remove('print-card', 'print-table');
  document.body.classList.add(`print-${part}`);
  window.print();
}
window.addEventListener('afterprint', () => document.body.classList.remove('print-card', 'print-table'));

// ---------------- render everything (initial + language switch) ----------------
function renderAll() {
  applyStatic();
  applyThemeButton();
  renderNotices();
  renderStamps();
  setTab(app.tab);
  table.render(app.model);
  renderChanges($('#changes'), app.model, (iso) => openCard(iso));
  weather.render();
  clinics.render();
  app.wxmap?.refresh();
  search.refresh();
  if (app.open) openCard(app.open, { focus: false, scroll: false });
}

async function main() {
  initLang();
  applyStatic();
  textSize.refresh();
  applyThemeButton();
  initPhoneNav();
  const wxData = loadWeather(); // non-critical, in parallel: weather.attach() renders it after the first paint
  wxData.catch(() => {});      // handled in attach(); avoid an "unhandled rejection" while the main data loads
  const [w, a, c] = await Promise.allSettled([
    getJSON('data/warnings.json'), getJSON('data/alerts.json'), getJSON('data/countries.json'),
  ]);
  const val = (r) => (r.status === 'fulfilled' && r.value && typeof r.value === 'object' ? r.value : null);
  const warnings = val(w);
  const alerts = val(a);
  if (!warnings) { console.warn('trip: warnings.json unavailable', w.reason); notice('notice_no_warnings'); }
  if (!alerts) { console.warn('trip: alerts.json unavailable', a.reason); notice('notice_no_alerts'); }
  if (!warnings && !alerts) notice('notice_failed');
  app.model = buildModel({ warnings, alerts, countries: val(c) });
  bindLevels(warnings, alerts);
  search.setModel(app.model);
  weather.setModel(app.model);
  if (!warnings && alerts) app.tab = 'cdc';
  renderAll();
  root.classList.remove('i18n-pending');

  const iso = location.hash.slice(1).toUpperCase();
  if (/^[A-Z]{2}$/.test(iso)) openCard(iso, { focus: false, fromUrl: true });
  const wxDone = weather.attach(wxData);
  clinics.start(); // travelmed.json: non-critical, after the first paint
  await initMap();
  await wxDone;
  document.body.dataset.ready = '1';
  // kiosks: pick up new data and new site code by themselves, but only after 5 minutes without any input,
  // so nobody loses a search or a card they are reading (the #country in the address survives the reload)
  autoReload({ data: true, idleMs: 5 * 60_000 });
}

main().catch((err) => {
  console.warn('trip: init failed', err);
  root.classList.remove('i18n-pending');
  notice('notice_failed');
});

// theme stored by an older visit may change in another tab
window.addEventListener('storage', (ev) => {
  if (ev.key === THEME_KEY) { root.dataset.theme = storageGet(THEME_KEY) === 'dark' ? 'dark' : 'light'; applyThemeButton(); }
});
