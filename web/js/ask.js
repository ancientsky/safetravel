// "要去哪裡？" beside the search box: common destinations from Taiwan as buttons — one tap opens the country, no
// typing. Off by default: ?ask=1 in the address switches it on (kiosk start pages). It steps aside while someone
// types or the on-screen keyboard is up, and only shows the buttons that fit beside the search box.
import { POPULAR_ISO } from './places.js';
import { t, countryName, getLang } from './i18n.js';
import { levelOf, warnLevel, mofaMode } from './state.js';
import { flagParam } from './params.js';

const MAX = 12;
// button text where the official short name is long (the full name stays as the tooltip and accessible name)
const SHORT = { 'zh-Hant': { HK: '香港', MO: '澳門' }, en: { CN: 'China' } };
const GAP = 12; // px kept free before whatever sits to the right

export const askWanted = () => flagParam('ask') === true;

export function createAsk({ searchRoot, onPick, has, obstacles = [] }) {
  const input = searchRoot.querySelector('input');
  const el = document.createElement('div');
  el.className = 'ask';
  el.dataset.testid = 'ask';
  el.setAttribute('role', 'group');
  searchRoot.append(el);

  function chip(iso) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ask-chip';
    b.dataset.iso = iso;
    const dot = document.createElement('i');
    dot.className = mofaMode() ? `ask-dot wl-${warnLevel(iso)}` : `ask-dot lvl-${levelOf(iso)}`;
    dot.setAttribute('aria-hidden', 'true');
    const full = countryName(iso);
    const short = SHORT[getLang() === 'en' ? 'en' : 'zh-Hant'][iso];
    if (short) { b.title = full; b.setAttribute('aria-label', full); }
    b.append(dot, short || full);
    return b;
  }

  /**
   * Keep the buttons that fit between the search box and the first thing to its right: one row beside the box, or
   * two when the switches under the search box end before this column (portrait screens).
   */
  function fit() {
    const chips = [...el.querySelectorAll('.ask-chip')];
    chips.forEach((c) => { c.hidden = false; });
    el.hidden = false;
    const box = searchRoot.getBoundingClientRect();
    const start = box.right + GAP;
    // what sits under the search box in the toolbar (layer switches, the weather day bar) and how far right it reaches
    const two = box.top + 2 * box.height + 8;
    const below = [...(searchRoot.parentElement?.children || [])].filter((n) => n !== searchRoot && !n.hidden)
      .flatMap((n) => (n.classList.contains('layer-row') ? [...n.children] : [n]))
      .map((n) => n.getBoundingClientRect())
      .filter((r) => r.width && r.top < two)
      .reduce((x, r) => Math.max(x, r.right), 0);
    const rows = below <= start - 4 ? 2 : 1;
    const bottom = rows === 2 ? two : box.bottom;
    let right = window.innerWidth - GAP;
    for (const o of obstacles) {
      if (!o || o.hidden) continue;
      const r = o.getBoundingClientRect();
      if (r.width && r.bottom > box.top && r.top < bottom && r.left >= box.right - 1) right = Math.min(right, r.left - GAP);
    }
    el.style.setProperty('--ask-h', `${Math.round(box.height)}px`);
    el.style.width = `${Math.max(0, Math.floor(right - start))}px`;
    const tops = [...new Set(chips.map((c) => c.offsetTop))].sort((a, b) => a - b).slice(0, rows);
    let shown = 0;
    // in order of popularity; one that does not fit is dropped and the next, shorter ones move up
    for (const c of chips) {
      if (tops.includes(c.offsetTop) && c.getBoundingClientRect().right <= right + 0.5) shown += 1; else c.hidden = true;
    }
    el.hidden = !!input.value.trim() || shown < 2;
  }

  function render() {
    el.setAttribute('aria-label', t('ask_label'));
    const q = document.createElement('span');
    q.className = 'ask-q';
    q.textContent = t('ask_title');
    el.replaceChildren(q, ...POPULAR_ISO.filter(has).slice(0, MAX).map(chip));
    fit();
  }

  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('.ask-chip');
    if (b) onPick(b.dataset.iso);
  });
  input.addEventListener('input', fit);
  window.addEventListener('resize', fit);
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(fit);
    ro.observe(searchRoot);
    if (searchRoot.parentElement) ro.observe(searchRoot.parentElement); // the weather day bar joins the toolbar
  }
  render();

  return {
    refresh: render,
    /** The layout beside the search box changed (panel, board): measure now and again once transitions end. */
    fit: () => { fit(); setTimeout(fit, 500); },
  };
}
