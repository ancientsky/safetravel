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

const THEME_KEY = 'safetravel.trip.theme';
const root = document.documentElement;

const app = {
  model: buildModel({}),
  tab: 'mofa',
  map: null,
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
$('.lang-toggle').addEventListener('click', () => {
  setLang(isEn() ? 'zh-Hant' : 'en');
  renderAll();
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
  app.tab = tab === 'cdc' ? 'cdc' : 'mofa';
  mapBox.dataset.tab = app.tab;
  $('#map-sec').dataset.tab = app.tab;
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === app.tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  });
  $('#map-panel').setAttribute('aria-labelledby', `tab-${app.tab}`);
  $('#tmap').setAttribute('aria-label', t(app.tab === 'mofa' ? 'map_label_mofa' : 'map_label_cdc'));
  renderLegend();
}
document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => setTab(b.dataset.tab));
  b.addEventListener('keydown', (ev) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
      ev.preventDefault();
      setTab(app.tab === 'mofa' ? 'cdc' : 'mofa', true);
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
    $('.z-in').addEventListener('click', () => app.map.zoomBy(1.6));
    $('.z-out').addEventListener('click', () => app.map.zoomBy(1 / 1.6));
    $('.z-reset').addEventListener('click', () => app.map.reset());
  } catch (err) {
    console.warn('trip: map unavailable', err);
    mapBox.classList.add('failed');
    notice('notice_no_map');
  }
}

// ---------------- card ----------------
function openCard(iso, { focus = true, scroll = true } = {}) {
  const d = app.model.dests.get(String(iso || '').toUpperCase());
  if (!d) return false;
  if (!app.open) app.returnFocus = document.activeElement;
  app.open = d.iso;
  renderCard(cardEl, d, { model: app.model, onClose: closeCard, onPrint: () => printPart('card') });
  cardEl.hidden = false;
  app.map?.select(d.iso);
  app.map?.hideTip();
  if (location.hash !== `#${d.iso}`) history.replaceState(null, '', `#${d.iso}`);
  if (scroll) cardEl.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  if (focus) $('#card-title')?.focus({ preventScroll: true });
  return true;
}

function closeCard() {
  cardEl.hidden = true;
  cardEl.replaceChildren();
  app.open = null;
  app.map?.select(null);
  history.replaceState(null, '', location.pathname + location.search);
  const back = app.returnFocus;
  app.returnFocus = null;
  if (back && back.isConnected && back !== document.body) back.focus({ preventScroll: false });
}
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && app.open && cardEl.contains(document.activeElement)) closeCard();
});
window.addEventListener('hashchange', () => {
  const iso = location.hash.slice(1).toUpperCase();
  if (iso && iso !== app.open) openCard(iso);
});

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
  search.refresh();
  if (app.open) openCard(app.open, { focus: false, scroll: false });
}

async function main() {
  initLang();
  applyStatic();
  applyThemeButton();
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
  if (!warnings && alerts) app.tab = 'cdc';
  renderAll();
  root.classList.remove('i18n-pending');

  const iso = location.hash.slice(1).toUpperCase();
  if (/^[A-Z]{2}$/.test(iso)) openCard(iso, { focus: false });
  await initMap();
  document.body.dataset.ready = '1';
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
