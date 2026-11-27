// trip.html: the four reference sections under the map and the destination card (travel medicine clinics, weather,
// recent changes, all destinations) are tabs of one panel, so the page is as long as one of them, not all four.
// A link to a section (the header chips, "find a clinic" in the card, a typed #weather) opens its tab first and
// the browser then scrolls to it as usual. ?view=weather|changes|all picks the tab shown first (default: clinics).
import { $ } from './util.js';

export const VIEWS = ['clinics', 'weather', 'changes', 'all'];

export function initViews({ onShow } = {}) {
  const box = $('#views');
  const bar = box?.querySelector('[role="tablist"]');
  if (!bar) return { show: () => false, current: () => null };
  const tabs = [...bar.querySelectorAll('[data-view]')];
  let cur = null;

  function show(v, { focusTab = false } = {}) {
    if (!VIEWS.includes(v)) return false;
    if (v !== cur) {
      cur = v;
      for (const b of tabs) {
        const on = b.dataset.view === v;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      for (const id of VIEWS) {
        const sec = document.getElementById(id);
        if (sec) sec.hidden = id !== v;
      }
      onShow?.(v);
    }
    if (focusTab) tabs.find((b) => b.dataset.view === v)?.focus();
    return true;
  }

  /** A tab chosen while the bar is stuck over the middle of a long list: start the new one at its top. */
  function toTop() {
    if (box.getBoundingClientRect().top < 0) box.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  bar.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-view]');
    if (!b) return;
    show(b.dataset.view);
    toTop();
  });
  bar.addEventListener('keydown', (ev) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const n = tabs.length;
    const j = { ArrowRight: i + 1, ArrowLeft: i - 1 + n, Home: 0, End: n - 1 }[ev.key];
    if (j == null) return;
    ev.preventDefault();
    show(tabs[j % n].dataset.view, { focusTab: true });
    toTop();
  });

  // capture: runs before the link's own navigation, so the section is visible when the browser scrolls to it
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest?.('a[href^="#"]');
    if (a) show(a.getAttribute('href').slice(1));
  }, true);
  // a typed or bookmarked #weather (hashchange does not fire when the hash is already that one)
  const fromHash = () => {
    const v = location.hash.slice(1);
    if (!VIEWS.includes(v) || v === cur) return;
    show(v);
    document.getElementById(v)?.scrollIntoView({ block: 'start' });
  };
  window.addEventListener('hashchange', fromHash);

  // the stuck bar's height, for what sits under it (trip.css: scroll margin, the clinic map)
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => document.documentElement.style.setProperty('--views-h', `${Math.ceil(box.offsetHeight)}px`)).observe(box);
  }

  const asked = new URLSearchParams(location.search).get('view');
  show(VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : VIEWS.includes(asked) ? asked : 'clinics');
  if (VIEWS.includes(location.hash.slice(1))) requestAnimationFrame(() => document.getElementById(cur)?.scrollIntoView({ block: 'start' }));
  return { show, current: () => cur };
}
