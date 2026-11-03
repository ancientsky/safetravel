// slide.html: health-education poster carousel for airport quarantine-station screens.
// Playlist = web/slides/slides.json (docs/SLIDES.md), filtered by active / from / until (Asia/Taipei) and this
// screen's settings. Settings: URL parameters > localStorage (safetravel.slide.*) > manifest > defaults.
import zhDict from '../i18n/slide-zh-Hant.js';
import enDict from '../i18n/slide-en.js';
import { renderSlide, TEMPLATES, assetSrc, h } from './slide-templates.js';

const MANIFEST = 'slides/slides.json';
const EXPORT_INDEX = 'slides/export/index.json';
const KEY = 'safetravel.slide.';
const LANG_KEY = 'safetravel.lang'; // shared with the other pages
const DIMS = { portrait: [1080, 1920], landscape: [1920, 1080] };
const REFRESH_MS = 5 * 60 * 1000;
const IDLE_MS = 3000;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const store = {
  get(k) { try { return localStorage.getItem(KEY + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(KEY + k, v); } catch { /* private mode / blocked storage */ } },
};
const params = new URLSearchParams(location.search);
const STILL = params.get('still') === '1';
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const clampInt = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && String(v).trim() !== '' ? Math.min(hi, Math.max(lo, n)) : null;
};

// ---------------------------------------------------------------- i18n (controls only; poster text is data)
const DICTS = { 'zh-Hant': zhDict, en: enDict };
let lang = 'zh-Hant';
function t(key, p = {}) {
  const v = DICTS[lang][key] ?? DICTS['zh-Hant'][key] ?? key;
  return String(v).replace(/\{(\w+)\}/g, (_, k) => (p[k] ?? ''));
}
function applyStatic() {
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-attr]').forEach((el) => {
    el.dataset.i18nAttr.split(';').forEach((pair) => {
      const [attr, key] = pair.split(':').map((x) => x.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
  document.documentElement.lang = lang;
  document.title = t('doc_title');
}
function initLang() {
  const q = params.get('lang');
  let stored = null;
  try { stored = localStorage.getItem(LANG_KEY); } catch { /* ignore */ }
  lang = q === 'en' ? 'en' : q === 'zh' ? 'zh-Hant' : stored === 'en' ? 'en' : 'zh-Hant';
}

// ---------------------------------------------------------------- state
const st = {
  manifest: null,
  text: '',
  playlist: [],      // manifest entries currently shown
  sections: [],
  idx: 0,
  playing: !STILL && params.get('play') !== '0',
  interval: 5,
  orient: 'portrait', // setting: portrait | landscape | auto
  only: null,        // Set of ids from ?only=
  posterLang: 'all', // all | zh | en
  hidden: new Set(),
  today: '',
  timer: 0,
  startedAt: 0,
  remaining: 0,
  dur: 0,
};

function readSettings(manifest) {
  const urlInterval = clampInt(params.get('interval') ?? '', 3, 60);
  st.interval = urlInterval ?? clampInt(store.get('interval') ?? '', 3, 60) ?? clampInt(manifest?.interval ?? '', 3, 60) ?? 5;
  const o = params.get('orient') || store.get('orient');
  st.orient = ['portrait', 'landscape', 'auto'].includes(o) ? o : 'portrait';
  const only = (params.get('only') || '').split(',').map((x) => x.trim()).filter(Boolean);
  st.only = only.length ? new Set(only) : null;
  const pl = { zh: 'zh', en: 'en', all: 'all' }[params.get('lang')] || store.get('lang');
  st.posterLang = ['zh', 'en'].includes(pl) ? pl : 'all';
  try {
    const hid = JSON.parse(store.get('hidden') || '[]');
    st.hidden = new Set(Array.isArray(hid) ? hid.filter((x) => typeof x === 'string') : []);
  } catch { st.hidden = new Set(); }
}

export function todayTaipei(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Minimal runtime check (the full check is pipeline/validate.py): a broken entry is skipped, never rendered. */
function validEntry(sl) {
  if (!sl || typeof sl !== 'object' || !ID_RE.test(sl.id || '') || !TEMPLATES.includes(sl.template)) return false;
  if ((sl.from && !DATE_RE.test(sl.from)) || (sl.until && !DATE_RE.test(sl.until))) return false;
  if (sl.template === 'image' && !assetSrc(sl.src)) return false;
  return true;
}

/** 'ok' or why the slide is not in this screen's playlist. */
function statusOf(sl, today) {
  if (!validEntry(sl)) return 'invalid';
  if (sl.active === false) return 'inactive';
  if (sl.from && today < sl.from) return 'scheduled';
  if (sl.until && today > sl.until) return 'expired';
  if (st.posterLang !== 'all' && sl.lang !== 'bi' && (sl.lang || 'zh') !== st.posterLang) return 'lang';
  if (st.only) return st.only.has(sl.id) ? 'ok' : 'only';
  if (st.hidden.has(sl.id)) return 'hidden';
  return 'ok';
}

const resolvedOrient = () => (st.orient === 'auto' ? (innerWidth > innerHeight ? 'landscape' : 'portrait') : st.orient);
const durationOf = (sl) => clampInt(sl?.duration ?? '', 2, 600) ?? st.interval;

// ---------------------------------------------------------------- DOM refs
const stage = $('#stage');
const slidesEl = $('.slides', stage);
const bar = $('.progress i', stage);
const dotsEl = $('.dots', stage);
const msg = $('.stage-msg', stage);
const ctl = $('#ctl');
const openBtn = $('.ctl-open');

// ---------------------------------------------------------------- layout
function fit() {
  const o = resolvedOrient();
  document.documentElement.dataset.orient = o;
  const [W, H] = DIMS[o];
  const s = Math.min(innerWidth / W, innerHeight / H);
  stage.style.setProperty('--s', String(s > 0 ? s : 1));
}

// ---------------------------------------------------------------- playlist
function rebuild(keepId) {
  const m = st.manifest;
  st.today = todayTaipei();
  const all = Array.isArray(m?.slides) ? m.slides : [];
  st.playlist = all.filter((sl) => statusOf(sl, st.today) === 'ok');
  const ctx = { wait: [] };
  st.sections = st.playlist.map((sl) => renderSlide(sl, m.brand, ctx));
  slidesEl.replaceChildren(...st.sections);
  stage.dataset.playlist = st.playlist.map((x) => x.id).join(',');
  dotsEl.replaceChildren(...st.playlist.map((sl) => h('li', { dataset: { id: sl.id } })));
  msg.hidden = st.playlist.length > 0;
  if (!st.playlist.length) msg.replaceChildren(h('b', { text: t('empty') }), h('span', { text: t('empty_hint') }));
  let i = keepId ? st.playlist.findIndex((x) => x.id === keepId) : -1;
  if (i < 0 && !keepId && params.get('slide')) i = st.playlist.findIndex((x) => x.id === params.get('slide'));
  show(Math.max(0, i));
  renderList();
  const imgs = $$('img', slidesEl).map((img) => img.decode().catch(() => null)); // decoded = painted on the first frame
  return Promise.allSettled([...ctx.wait, ...imgs]);
}

/** Re-check the date window (midnight Asia/Taipei) and rebuild when the playlist changed. */
function recheck() {
  const today = todayTaipei();
  if (today === st.today) return false;
  const ids = (st.manifest?.slides || []).filter((sl) => statusOf(sl, today) === 'ok').map((x) => x.id).join(',');
  st.today = today;
  if (ids === stage.dataset.playlist) return false;
  rebuild(st.playlist[st.idx]?.id);
  return true;
}

let leaveTimer = 0;
function show(i) {
  const n = st.sections.length;
  clearTimeout(st.timer);
  if (!n) { stage.dataset.current = ''; updateCounter(); return; }
  const prev = st.sections[st.idx];
  st.idx = ((i % n) + n) % n;
  const cur = st.sections[st.idx];
  clearTimeout(leaveTimer);
  st.sections.forEach((el) => { if (el !== cur && el !== prev) el.classList.remove('is-active', 'is-leaving'); });
  if (prev && prev !== cur && prev.isConnected) {
    prev.classList.add('is-leaving');
    prev.classList.remove('is-active');
    leaveTimer = setTimeout(() => prev.classList.remove('is-leaving'), 700);
  }
  cur.classList.remove('is-active', 'is-leaving');
  void cur.offsetWidth; // restart the entrance animations
  cur.classList.add('is-active');
  cur.slideEnter?.(STILL || reduced());
  stage.dataset.current = st.playlist[st.idx].id;
  $$('li', dotsEl).forEach((d, j) => d.classList.toggle('on', j === st.idx));
  updateCounter();
  startTimer();
}

function startTimer() {
  clearTimeout(st.timer);
  st.dur = durationOf(st.playlist[st.idx]) * 1000;
  st.remaining = st.dur;
  st.startedAt = performance.now();
  stage.dataset.duration = String(st.dur / 1000);
  if (st.playing && st.sections.length > 1) st.timer = setTimeout(advance, st.remaining);
  else if (st.playing && st.sections.length === 1) st.timer = setTimeout(() => { if (!recheck()) startTimer(); }, st.remaining);
}
function advance() {
  if (recheck()) return;
  show(st.idx + 1);
}
function step(d) {
  if (recheck() && d > 0) return;
  show(st.idx + d);
}
function setPlaying(on) {
  if (on === st.playing) return;
  if (on) {
    st.playing = true;
    st.startedAt = performance.now();
    if (st.sections.length) st.timer = setTimeout(st.sections.length > 1 ? advance : startTimer, Math.max(0, st.remaining));
    wake();
  } else {
    st.playing = false;
    clearTimeout(st.timer);
    st.remaining -= performance.now() - st.startedAt;
    unwake();
  }
  document.body.classList.toggle('paused', !st.playing);
  updatePlayBtn();
}

function tick(now) {
  if (st.dur > 0 && st.sections.length) {
    const left = st.playing ? st.remaining - (now - st.startedAt) : st.remaining;
    bar.style.transform = `scaleX(${Math.min(1, Math.max(0, 1 - left / st.dur)).toFixed(4)})`;
  }
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- manifest loading / live refresh
async function fetchManifest() {
  const r = await fetch(`${MANIFEST}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  return { text, data: JSON.parse(text) };
}
async function refresh() {
  try {
    const { text, data } = await fetchManifest();
    if (text === st.text) return recheck();
    st.text = text;
    st.manifest = data;
    await rebuild(st.playlist[st.idx]?.id);
    st.sections[st.idx]?.slideEnter?.(STILL || reduced());
    renderDownloads();
    stage.dataset.refreshed = String(Date.now());
  } catch (e) {
    console.warn('slides: refresh failed, keeping the current playlist', e);
  }
  return true;
}

// ---------------------------------------------------------------- settings panel
let idleTimer = 0;
let pinned = false;
function setPanel(open) {
  ctl.classList.toggle('open', open);
  ctl.setAttribute('aria-hidden', open ? 'false' : 'true');
  ctl.inert = !open;
  openBtn.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('ctl-on', open);
}
function wakeUi() {
  if (STILL) return;
  document.body.classList.remove('idle');
  if (!ctl.classList.contains('open')) setPanel(true);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(goIdle, IDLE_MS);
}
function goIdle() {
  if (ctl.matches(':hover')) { idleTimer = setTimeout(goIdle, IDLE_MS); return; }
  document.body.classList.add('idle');
  if (!pinned) setPanel(false);
}

function updateCounter() {
  const n = st.playlist.length;
  const sl = st.playlist[st.idx];
  $('.ctl-counter').textContent = n ? `${t('counter', { n: st.idx + 1, total: n })} · ${t(`tpl_${sl.template}`)} · ${sl.id}` : t('empty');
}
function updatePlayBtn() {
  const b = $('.btn-play');
  b.setAttribute('aria-pressed', String(st.playing));
  b.title = t(st.playing ? 'pause' : 'play');
  $('.play-label').textContent = b.title;
}
function updateTheme() {
  const dark = document.documentElement.dataset.theme !== 'light';
  $('.theme-text').textContent = t(dark ? 'theme_to_light' : 'theme_to_dark');
}

function renderList() {
  const list = $('[data-testid="slide-list"]');
  const all = Array.isArray(st.manifest?.slides) ? st.manifest.slides : [];
  list.replaceChildren(...all.map((sl, i) => {
    const status = statusOf(sl, st.today);
    const id = typeof sl?.id === 'string' ? sl.id : `#${i + 1}`;
    const manifestOff = ['invalid', 'inactive', 'scheduled', 'expired'].includes(status);
    const box = h('input', { type: 'checkbox', dataset: { id }, 'aria-label': id });
    box.checked = !st.hidden.has(id);
    box.disabled = status === 'invalid' || !!st.only;
    box.addEventListener('change', () => {
      if (box.checked) st.hidden.delete(id); else st.hidden.add(id);
      store.set('hidden', JSON.stringify([...st.hidden]));
      rebuild(st.playlist[st.idx]?.id);
    });
    const badge = status === 'ok' ? null
      : h('span', { class: `badge b-${status}`, text: t(`st_${status}`, { date: status === 'scheduled' ? sl.from : sl.until }) });
    const go = h('button', { type: 'button', class: 'go', disabled: status !== 'ok' },
      h('b', { text: TEMPLATES.includes(sl?.template) ? t(`tpl_${sl.template}`) : '?' }),
      h('span', { class: 'mono', text: `${id}${sl?.lang ? ` · ${sl.lang}` : ''}` }));
    go.addEventListener('click', () => show(st.playlist.findIndex((x) => x.id === id)));
    return h('li', { class: `${status === 'ok' ? 'on' : 'off'}${manifestOff ? ' m-off' : ''}`, dataset: { id, status } }, box, go, badge);
  }));
}

async function sha256(text) {
  if (!globalThis.crypto?.subtle) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
const exportFile = (f) => (typeof f === 'string' && /^[A-Za-z0-9._-]+\.(png|pdf)$/.test(f) ? `slides/export/${f}` : '');

async function renderDownloads() {
  const box = $('[data-testid="downloads"]');
  let idx = null;
  try {
    const r = await fetch(`${EXPORT_INDEX}?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) idx = await r.json();
  } catch { /* not exported yet */ }
  if (!idx || !Array.isArray(idx.slides)) {
    box.replaceChildren(h('p', { class: 'hint', dataset: { testid: 'dl-none' }, text: t('dl_none') }));
    return;
  }
  const pdf = (o) => exportFile(idx.pdf?.[o]);
  const link = (href, text, cls = 'dl') => (href ? h('a', { class: cls, href, download: '', text }) : null);
  const pngs = idx.slides.filter((x) => x && typeof x.id === 'string');
  const kids = [
    pdf('portrait') || pdf('landscape')
      ? h('p', { class: 'dl-row' }, link(pdf('portrait'), t('dl_pdf_portrait')), link(pdf('landscape'), t('dl_pdf_landscape')))
      : h('p', { class: 'hint', dataset: { testid: 'dl-pdf-hint' }, text: t('dl_pdf_print') }),
    h('details', { class: 'dl-png' },
      h('summary', { text: t('dl_png', { n: pngs.length * 2 }) }),
      h('ul', {}, pngs.map((x) => h('li', {},
        h('span', { class: 'mono', text: x.id }),
        link(exportFile(x.portrait), t('dl_png_portrait')),
        link(exportFile(x.landscape), t('dl_png_landscape')))))),
  ];
  const hash = await sha256(st.text);
  if (hash && idx.manifest_sha256 && hash !== idx.manifest_sha256) kids.push(h('p', { class: 'hint warn', text: t('dl_stale') }));
  box.replaceChildren(...kids);
}

// ---------------------------------------------------------------- wake lock (screens must not sleep while playing)
let lock = null;
async function wake() {
  if (STILL || !st.playing || lock || document.visibilityState !== 'visible' || !navigator.wakeLock?.request) return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
  } catch { lock = null; /* not allowed here: fine */ }
}
function unwake() {
  const l = lock;
  lock = null;
  l?.release?.().catch(() => {});
}

// ---------------------------------------------------------------- wiring
function toggleFullscreen() {
  const d = document;
  if (d.fullscreenElement) d.exitFullscreen?.().catch(() => {});
  else d.documentElement.requestFullscreen?.().catch(() => {});
}

function bind() {
  ctl.hidden = false;
  document.body.classList.add('idle'); // kiosk: no cursor and no controls until someone moves the mouse / taps
  setPanel(false);
  const intervalIn = $('[data-testid="interval"]');
  const orientSel = $('[data-testid="orient"]');
  const langSel = $('[data-testid="poster-lang"]');
  intervalIn.value = String(st.interval);
  orientSel.value = st.orient;
  langSel.value = st.posterLang;
  intervalIn.addEventListener('change', () => {
    const v = clampInt(intervalIn.value, 3, 60) ?? st.interval;
    intervalIn.value = String(v);
    st.interval = v;
    store.set('interval', String(v));
    show(st.idx);
  });
  orientSel.addEventListener('change', () => {
    st.orient = orientSel.value;
    store.set('orient', st.orient);
    fit();
    show(st.idx);
  });
  langSel.addEventListener('change', () => {
    st.posterLang = langSel.value;
    store.set('lang', st.posterLang);
    rebuild(st.playlist[st.idx]?.id);
  });
  ctl.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'prev') step(-1);
    else if (act === 'next') step(1);
    else if (act === 'play') setPlaying(!st.playing);
    else if (act === 'fullscreen') toggleFullscreen();
    else if (act === 'print') window.print();
  });
  $('.ctl-close').addEventListener('click', () => { pinned = false; setPanel(false); });
  openBtn.addEventListener('click', () => { pinned = true; wakeUi(); });
  $('.lang-toggle').addEventListener('click', () => {
    lang = lang === 'en' ? 'zh-Hant' : 'en';
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
    applyStatic(); updateCounter(); updatePlayBtn(); updateTheme(); renderList(); renderDownloads();
  });
  $('.theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
    updateTheme();
  });

  for (const ev of ['mousemove', 'pointerdown', 'touchstart', 'wheel']) addEventListener(ev, wakeUi, { passive: true });
  addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const tag = e.target?.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    if (typing && e.key !== 'Escape') return;
    const onButton = tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY';
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); step(-1); }
    else if ((e.key === ' ' || e.key === 'k') && !onButton) { e.preventDefault(); setPlaying(!st.playing); }
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    else if (e.key === 's' || e.key === 'S') {
      pinned = !ctl.classList.contains('open') || !pinned;
      setPanel(pinned);
      if (pinned) $('.btn-play').focus({ preventScroll: true });
    } else if (e.key === 'Escape') { pinned = false; setPanel(false); }
  });
  addEventListener('resize', () => { const o = document.documentElement.dataset.orient; fit(); if (o !== document.documentElement.dataset.orient) show(st.idx); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  document.addEventListener('slides:refresh', () => { refresh(); }); // test / ops hook: re-read slides.json now
  setInterval(refresh, REFRESH_MS);
}

async function main() {
  initLang();
  applyStatic();
  document.body.classList.toggle('paused', !st.playing);
  try {
    const { text, data } = await fetchManifest();
    st.text = text;
    st.manifest = data;
  } catch (e) {
    console.warn('slides: cannot load the manifest', e);
    st.manifest = { slides: [] };
    readSettings(null);
    fit();
    bind();
    msg.hidden = false;
    msg.replaceChildren(h('b', { text: t('load_error') }));
    document.body.dataset.ready = '1';
    return;
  }
  readSettings(st.manifest);
  fit();
  bind();
  updatePlayBtn();
  updateTheme();
  await rebuild();
  st.sections[st.idx]?.slideEnter?.(STILL || reduced()); // the map (and its plane) is drawn asynchronously
  renderDownloads();
  requestAnimationFrame(tick);
  wake();
  document.body.dataset.ready = '1';
}

main();
