// Spotlight carousel: periodically flies the map to a (weighted) random advisory country.
import { state, on, levelOf, alertsOf } from './state.js';
import {
  t, countryName, countryAltName, diseaseName, levelShort, badge, fmtDay, pick, isEn,
} from './i18n.js';
import { esc, clean, truncate, weightedPick, reducedMotion, $ } from './util.js';

const INTERVAL = 9000;
const TICK = 100;
const USER_COOLDOWN = 15000;
const WEIGHT = { 1: 1, 2: 4, 3: 10 };

export function createSpotlight({ root, map, panel }) {
  const card = $('.spot-card', root);
  const bar = $('.spot-progress i', root);
  const playBtn = $('.spot-play', root);
  const nextBtn = $('.spot-next', root);
  let iso = null;
  let elapsed = 0;
  let hovering = false;
  let userUntil = 0;
  let history = [];
  let timer = 0;

  const candidates = () => Object.keys(state.data.alerts?.countries || {})
    .filter((c) => map.has(c) && levelOf(c) > 0);

  function choose() {
    const list = candidates().filter((c) => !history.includes(c));
    const pool = list.length ? list : candidates();
    if (!pool.length) return null;
    return weightedPick(pool, (c) => WEIGHT[levelOf(c)] || 1);
  }

  function pad() {
    const narrow = window.innerWidth < 760;
    if (narrow) return { top: 150, bottom: root.offsetHeight + 90 };
    return { top: 150, left: 300, right: root.offsetWidth + 40, bottom: 60 };
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

  function next() {
    // Under reduced motion the carousel only swaps the card + outline, never moves the map.
    show(choose(), { fly: !reducedMotion() });
  }

  function render() {
    if (!iso) {
      card.innerHTML = `<p class="spot-scan">${esc(t('spot_scanning'))}</p>`;
      return;
    }
    const lvl = levelOf(iso);
    const advs = alertsOf(iso);
    // de-duplicate diseases (sub-national rows repeat the same disease)
    const seen = new Set();
    const top = [];
    for (const a of advs) {
      if (seen.has(a.disease)) continue;
      seen.add(a.disease);
      top.push(a);
      if (top.length === 3) break;
    }
    let recent = '';
    let ai = '';
    if (state.epidemicsStatus === 'ready') {
      const it = state.byCountry.get(iso)?.[0];
      if (it) {
        const s = pick(it, 'summary').text || pick(it, 'headline').text;
        recent = `<div class="spot-recent"><span class="spot-label">${esc(t('spot_recent'))} · <time class="mono">${esc(fmtDay(it.date, 'short'))}</time></span><p>${esc(truncate(s, 96))}</p></div>`;
      }
      const ov = state.data.epidemics?.overviews?.[iso];
      if (ov) {
        const txt = clean(isEn() ? ov.en || ov.zh : ov.zh || ov.en);
        const isAi = ov.ai === true || (ov.ai !== false && (state.data.meta?.counts?.ai_translated ?? 0) > 0);
        ai = `<div class="spot-ai${isAi ? '' : ' is-auto'}">${isAi ? '<span class="chip chip-ai-mini">AI</span>' : ''}<p>${esc(truncate(txt, 110))}</p></div>`;
      }
    } else if (state.epidemicsStatus === 'loading') {
      recent = `<div class="skeleton skeleton-sm" aria-busy="true"><span></span><span></span><em>${esc(t('loading_digests'))}</em></div>`;
    }
    card.innerHTML = `
      <div class="spot-title">
        ${badge(lvl)}
        <div><h3>${esc(countryName(iso))}</h3><p class="spot-alt">${esc(countryAltName(iso))} · <span class="mono">${esc(iso)}</span></p></div>
      </div>
      <ul class="spot-advs">${top.map((a) => `<li><span class="dot lvl-${a.level}" aria-hidden="true"></span><span class="spot-lv mono">L${a.level}</span>${esc(diseaseName(a.disease))}</li>`).join('')}${advs.length > top.length ? `<li class="more mono">+${advs.length - top.length}</li>` : ''}</ul>
      ${ai}${recent}
      <span class="spot-open">${esc(t('spot_open'))} →</span>`;
    card.setAttribute('aria-label', `${countryName(iso)} — ${levelShort(lvl)} — ${t('spot_open')}`);
  }

  function paused() {
    return !state.spotlight.playing || hovering || panel.isOpen() || Date.now() < userUntil || document.hidden;
  }

  function syncButtons() {
    const playing = state.spotlight.playing;
    playBtn.setAttribute('aria-pressed', String(!playing));
    playBtn.setAttribute('aria-label', playing ? t('spot_pause') : t('spot_play'));
    playBtn.title = playBtn.getAttribute('aria-label');
    playBtn.dataset.state = playing ? 'playing' : 'paused';
    nextBtn.setAttribute('aria-label', t('spot_next'));
    nextBtn.title = t('spot_next');
    root.setAttribute('aria-label', t('spot_label'));
  }

  function tick() {
    const p = paused();
    root.classList.toggle('is-paused', p);
    if (!p) {
      elapsed += TICK;
      if (elapsed >= INTERVAL) next();
    }
    bar.style.transform = `scaleX(${Math.min(1, elapsed / INTERVAL)})`;
  }

  card.addEventListener('click', () => { if (iso) panel.open(iso); });
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
  on('map:user', () => { userUntil = Date.now() + USER_COOLDOWN; });
  on('panel:close', () => { if (iso) map.setSpotlight(iso); });

  function start() {
    syncButtons();
    // First pick only highlights (keeps the world overview on load); flying starts next cycle.
    show(choose(), { fly: false });
    clearInterval(timer);
    timer = setInterval(tick, TICK);
  }

  return {
    start,
    next,
    show,
    refresh: () => { render(); syncButtons(); },
    current: () => iso,
  };
}
