// Spotlight carousel: periodically flies the map to a (weighted) random advisory country.
import {
  state, on, emit, levelOf, alertsOf, groupAlerts,
} from './state.js';
import {
  t, countryName, countryAltName, diseaseName, badge, fmtDay, pick, isEn,
} from './i18n.js';
import {
  esc, clean, truncate, weightedPick, reducedMotion, storageGet, storageSet, clamp, levelNum, $,
} from './util.js';

const INTERVAL = 15000;
const SCROLL_DELAY = 2500; // let the header/advisories be read first
const SCROLL_LEAD = 1000; // reach the bottom this long before the next country
// Auto-scroll glides at a constant, readable pace regardless of how long the panel is; the cycle
// stretches to fit (see cycleLength), bounded by MAX_GLIDE so one country never monopolises the tour.
const SCROLL_SPEED = 60; // px per second
const MAX_GLIDE = 75000; // ms
const TICK = 100;
const USER_COOLDOWN = 15000;
const WEIGHT = { 1: 1, 2: 4, 3: 10 };
const AUTO_KEY = 'safetravel.spotlightAutoOpen';
const SCROLL_KEY = 'safetravel.spotlightAutoScroll';

export function createSpotlight({ root, map, panel }) {
  const card = $('.spot-card', root);
  const bar = $('.spot-progress i', root);
  const playBtn = $('.spot-play', root);
  const nextBtn = $('.spot-next', root);
  const autoBtn = $('[data-testid="spotlight-autoopen"]', root);
  const autobar = document.querySelector('.panel-autobar');
  const autobarFill = autobar?.querySelector('.pa-progress b');
  const autobarBtn = autobar?.querySelector('.pa-toggle');
  const scrollBtn = $('[data-testid="spotlight-autoscroll"]', root);
  const scrollWrap = scrollBtn.closest('.spot-auto');
  state.spotlight.autoOpen = storageGet(AUTO_KEY) === 'on';
  state.spotlight.autoScroll = storageGet(SCROLL_KEY) !== 'off';
  let autoIso = null; // country whose panel the carousel itself opened
  let scrollCancelled = false;
  let lastTickAt = 0;
  let scrollRaf = 0;
  let iso = null;
  let elapsed = 0;
  let hovering = false;
  let userUntil = 0;
  let history = [];
  let timer = 0;

  // only countries with a targeted advisory (not just the global background one) are worth a spotlight
  const candidates = () => Object.entries(state.data.alerts?.countries || {})
    .filter(([c, v]) => map.has(c) && levelOf(c) > 0 && (v.alerts || []).some((a) => !a.global))
    .map(([c]) => c);

  function choose() {
    const list = candidates().filter((c) => !history.includes(c));
    const pool = list.length ? list : candidates();
    if (!pool.length) return null;
    return weightedPick(pool, (c) => WEIGHT[levelOf(c)] || 1);
  }

  // Card size cached from a ResizeObserver: reading offsetWidth right after re-rendering the card
  // would force a synchronous layout on every cycle.
  let box = { w: 372, h: 384 };
  if ('ResizeObserver' in window) {
    new ResizeObserver(([e]) => {
      const b = e.borderBoxSize?.[0];
      box = b ? { w: b.inlineSize, h: b.blockSize } : { w: e.contentRect.width, h: e.contentRect.height };
    }).observe(root);
  }

  function pad() {
    const narrow = window.innerWidth < 760;
    if (narrow) return { top: 150, bottom: box.h + 90 };
    return { top: 150, left: 300, right: box.w + 40, bottom: 60 };
  }

  function show(code, { fly = true } = {}) {
    if (!code) return;
    iso = code;
    state.spotlight.iso = code;
    history = [code, ...history].slice(0, 6);
    elapsed = 0;
    render();
    map.setSpotlight(code);
    if (fly && !panel.isOpen()) map.flyTo(code, { pad: pad(), maxScale: 4, ms: 2000 });
  }

  function next(forced) {
    const code = forced || choose();
    if (!code) return;
    if (state.spotlight.autoOpen) {
      // Auto-open: the panel does the fly-to (padded for the panel) and keeps focus where it is.
      show(code, { fly: false });
      autoIso = code;
      scrollCancelled = false;
      panel.open(code, { focus: false, fly: !reducedMotion() });
      ensureScroll();
    } else {
      // Under reduced motion the carousel only swaps the card + outline, never moves the map.
      show(code, { fly: !reducedMotion() });
    }
  }

  // ---- auto-scroll of an auto-opened panel across the cycle ----
  function scrollActive() {
    return state.spotlight.autoOpen && state.spotlight.autoScroll && !scrollCancelled
      && autoIso && panel.isOpen() && panel.current() === autoIso;
  }

  /** Length of the current cycle: 15 s, or longer while an auto-scroll glide is running. */
  function glideMs(max) {
    return Math.min(MAX_GLIDE, (max / SCROLL_SPEED) * 1000);
  }

  function cycleLength() {
    if (!scrollActive()) return INTERVAL;
    const el = panel.scroller();
    const max = el ? el.scrollHeight - el.clientHeight : 0;
    if (max <= 2) return INTERVAL;
    return Math.max(INTERVAL, SCROLL_DELAY + glideMs(max) + SCROLL_LEAD);
  }

  function ensureScroll() {
    if (!scrollRaf && scrollActive()) scrollRaf = requestAnimationFrame(stepScroll);
  }

  function stepScroll() {
    scrollRaf = 0;
    if (!scrollActive()) return;
    const el = panel.scroller(); // the panel's own scroll container (desktop and bottom sheet)
    const max = el.scrollHeight - el.clientHeight;
    if (max > 2) { // content that fits needs no scrolling
      // interpolate between 100 ms ticks for a smooth, linear glide
      const e = elapsed + (paused() ? 0 : Math.min(TICK, performance.now() - lastTickAt));
      let p = clamp((e - SCROLL_DELAY) / glideMs(max), 0, 1);
      if (reducedMotion()) p = Math.floor(p * 3 + 1e-6) / 3; // three discrete jumps, no glide
      const target = Math.round(p * max);
      if (Math.abs(el.scrollTop - target) >= 1) el.scrollTop = target;
    }
    scrollRaf = requestAnimationFrame(stepScroll);
  }

  /** User touched the map / panel: hold the carousel for a while, then resume. */
  function cooldown() {
    userUntil = Date.now() + USER_COOLDOWN;
  }

  function render() {
    if (!iso) {
      card.innerHTML = `<span class="spot-scan">${esc(t('spot_scanning'))}</span>`;
      return;
    }
    const lvl = levelOf(iso);
    const groups = groupAlerts(iso); // sub-national rows of one disease/level collapse into one chip
    const top = groups.slice(0, 3);
    let recent = '';
    let ai = '';
    if (state.epidemicsStatus === 'ready') {
      const it = state.byCountry.get(iso)?.[0];
      if (it) {
        const s = pick(it, 'summary').text || pick(it, 'headline').text;
        recent = `<span class="spot-recent"><span class="spot-label">${esc(t('spot_recent'))} · <time class="mono">${esc(fmtDay(it.date, 'short'))}</time></span><span class="spot-text">${esc(truncate(s, 96))}</span></span>`;
      }
      const ov = state.data.epidemics?.overviews?.[iso];
      if (ov) {
        const txt = clean(isEn() ? ov.en || ov.zh : ov.zh || ov.en);
        const isAi = ov.ai === true || (ov.ai !== false && (state.data.meta?.counts?.ai_translated ?? 0) > 0);
        ai = `<span class="spot-ai${isAi ? '' : ' is-auto'}">${isAi ? '<span class="chip chip-ai-mini">AI</span>' : ''}<span class="spot-text">${esc(truncate(txt, 110))}</span></span>`;
      }
    } else if (state.epidemicsStatus === 'loading') {
      recent = `<span class="skeleton skeleton-sm spot-skeleton" aria-busy="true"><span></span><span></span><span></span><em>${esc(t('loading_digests'))}</em></span>`;
    }
    // Only phrasing content (spans) inside the <button>: no headings, lists or divs.
    card.innerHTML = `
      <span class="spot-title">
        ${badge(lvl)}
        <span class="spot-names"><span class="spot-name">${esc(countryName(iso))}</span><span class="spot-alt">${esc(countryAltName(iso))} · <span class="mono">${esc(iso)}</span></span></span>
      </span>
      <span class="spot-advs">${top.map((g) => `<span class="spot-adv"><span class="dot lvl-${levelNum(g.level)}" aria-hidden="true"></span><span class="spot-lv mono">L${levelNum(g.level)}</span>${esc(diseaseName(g.disease))}${g.areas.length > 1 ? `<span class="spot-n mono">×${g.areas.length}</span>` : ''}</span>`).join('')}${groups.length > top.length ? `<span class="spot-adv more mono">+${groups.length - top.length}</span>` : ''}</span>
      ${ai}${recent}
      <span class="spot-open">${esc(t('spot_open'))} →</span>`;
  }

  function paused() {
    const auto = state.spotlight.autoOpen;
    const open = panel.isOpen();
    // With auto-open the panel being open is the normal state, so it must not pause the tour.
    return !state.spotlight.playing
      || (hovering && !open)
      || (open && !auto)
      || Date.now() < userUntil
      || document.hidden;
  }

  function syncButtons() {
    const playing = state.spotlight.playing;
    playBtn.setAttribute('aria-pressed', String(!playing));
    playBtn.setAttribute('aria-label', playing ? t('spot_pause') : t('spot_play'));
    playBtn.title = playBtn.getAttribute('aria-label');
    playBtn.dataset.state = playing ? 'playing' : 'paused';
    autoBtn.setAttribute('aria-checked', String(state.spotlight.autoOpen));
    autoBtn.title = t('spot_autoopen');
    scrollBtn.setAttribute('aria-checked', String(state.spotlight.autoScroll));
    scrollBtn.title = t('spot_autoscroll');
    scrollWrap.hidden = !state.spotlight.autoOpen; // only meaningful with full details on
    scrollBtn.disabled = !state.spotlight.autoOpen;
    if (autobarBtn) {
      autobarBtn.dataset.state = playing ? 'playing' : 'paused';
      autobarBtn.setAttribute('aria-label', playing ? t('panel_auto_pause') : t('panel_auto_play'));
      autobarBtn.title = autobarBtn.getAttribute('aria-label');
    }
    nextBtn.setAttribute('aria-label', t('spot_next'));
    nextBtn.title = t('spot_next');
    root.setAttribute('aria-label', t('spot_label'));
  }

  function tick() {
    lastTickAt = performance.now();
    const p = paused();
    let len = cycleLength(); // layout reads first, DOM writes after
    if (!p) {
      elapsed += TICK;
      if (elapsed >= len) {
        emit('spotlight:cycle'); // quiet moment: the auto-refresh may reload here
        next();
        len = INTERVAL; // new country starts at the top; its glide length is re-measured next tick
      }
    }
    root.classList.toggle('is-paused', p);
    const progress = `scaleX(${Math.min(1, elapsed / len)})`;
    bar.style.transform = progress;
    if (autobar) {
      const showBar = state.spotlight.autoOpen && panel.isOpen();
      if (autobar.hidden === showBar) autobar.hidden = !showBar;
      autobar.classList.toggle('is-paused', p);
      if (showBar) autobarFill.style.transform = progress;
    }
    ensureScroll();
  }

  card.addEventListener('click', () => {
    if (!iso) return;
    if (state.spotlight.autoOpen) cooldown();
    panel.open(iso);
  });
  autoBtn.addEventListener('click', () => {
    state.spotlight.autoOpen = !state.spotlight.autoOpen;
    storageSet(AUTO_KEY, state.spotlight.autoOpen ? 'on' : 'off');
    syncButtons();
  });
  scrollBtn.addEventListener('click', () => {
    state.spotlight.autoScroll = !state.spotlight.autoScroll;
    storageSet(SCROLL_KEY, state.spotlight.autoScroll ? 'on' : 'off');
    syncButtons();
  });
  autobarBtn?.addEventListener('click', () => {
    state.spotlight.playing = !state.spotlight.playing;
    userUntil = 0;
    syncButtons();
  });
  playBtn.addEventListener('click', () => {
    state.spotlight.playing = !state.spotlight.playing;
    userUntil = 0;
    syncButtons();
  });
  nextBtn.addEventListener('click', () => { userUntil = 0; next(); });
  root.addEventListener('pointerenter', () => { hovering = true; });
  root.addEventListener('pointerleave', () => { hovering = false; });
  root.addEventListener('focusin', () => { hovering = true; });
  root.addEventListener('focusout', () => { hovering = false; });
  on('map:user', cooldown);
  // Panel wheel/touch/click/keys, manual country open (search, map click, deep link):
  // pause the tour and stop auto-scrolling this country.
  on('user:interact', () => {
    cooldown();
    scrollCancelled = true;
  });
  on('panel:close', () => {
    cooldown(); // closing the panel by hand holds the tour ~15 s, then it resumes
    if (iso) map.setSpotlight(iso);
  });

  function start() {
    syncButtons();
    // First pick only highlights (keeps the world overview on load); flying starts next cycle.
    show(choose(), { fly: false });
    clearInterval(timer);
    timer = setInterval(tick, TICK);
  }

  // No timers while the tab is hidden; resume where the cycle left off.
  document.addEventListener('visibilitychange', () => {
    clearInterval(timer);
    timer = document.hidden ? 0 : setInterval(tick, TICK);
  });

  return {
    start,
    next,
    show,
    refresh: () => { render(); syncButtons(); },
    current: () => iso,
  };
}
