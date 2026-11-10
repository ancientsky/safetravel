// trip.html on phones (trip.css, screens up to 760 px wide): the header stays stuck with only its row of section
// chips showing, the chip of the section being read is marked, and a "back to top" button appears further down.
// Wider screens get none of it: nothing is measured, marked or shown there.
import { $, reducedMotion } from './util.js';

const PHONE = '(max-width: 760px)';

export function initPhoneNav() {
  const root = document.documentElement;
  const header = $('.top');
  const nav = $('.jump');
  const toTop = $('.to-top');
  const foot = $('.foot');
  if (!header || !nav || typeof matchMedia !== 'function') return;
  const mq = matchMedia(PHONE);
  // the page's sections in page order, each with its chip (the destination card has none: no chip is marked there)
  const chips = new Map([...nav.querySelectorAll('a[href^="#"]')].map((a) => [a.getAttribute('href').slice(1), a]));
  const links = [...document.querySelectorAll('main > section[id]')].map((sec) => ({ sec, a: chips.get(sec.id) || null }));

  let hide = 0;    // px of header above the chip row: the header sticks at top: -hide
  let barH = 0;    // px of header that stays visible
  let io = null;
  let ioBar = -1;
  const inView = new Set();
  let current = null;

  function mark() {
    const next = mq.matches ? links.filter((x) => inView.has(x.sec)).pop() || null : null;
    if (next === current) return;
    current?.a?.removeAttribute('aria-current');
    current = next;
    if (!next?.a) return;
    next.a.setAttribute('aria-current', 'location');
    // keep the marked chip inside the scrolling row (never scrolls the page)
    const n = nav.getBoundingClientRect();
    const c = next.a.getBoundingClientRect();
    nav.scrollTo({ left: nav.scrollLeft + c.left - n.left - (n.width - c.width) / 2, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  /** "Current" is the last section that reaches into the band from the chip row to about a third of the way down. */
  function watch() {
    if (typeof IntersectionObserver !== 'function') return;
    if (io && ioBar === barH) return;
    io?.disconnect();
    inView.clear();
    ioBar = barH;
    io = new IntersectionObserver((entries) => {
      for (const e of entries) { if (e.isIntersecting) inView.add(e.target); else inView.delete(e.target); }
      mark();
    }, { rootMargin: `-${barH + 4}px 0px -65% 0px` });
    for (const x of links) io.observe(x.sec);
  }

  function measure() {
    if (!mq.matches) {
      root.style.removeProperty('--jump-top');
      root.style.removeProperty('--jump-h');
      io?.disconnect();
      io = null;
      ioBar = -1;
      inView.clear();
      mark();
      return;
    }
    const h = header.getBoundingClientRect();
    hide = Math.max(0, Math.floor(nav.getBoundingClientRect().top - h.top));
    barH = Math.ceil(h.height - hide);
    root.style.setProperty('--jump-top', `${-hide}px`);
    root.style.setProperty('--jump-h', `${barH}px`);
    watch();
  }

  function onScroll() {
    const phone = mq.matches;
    const y = window.scrollY;
    header.classList.toggle('is-stuck', phone && y > hide);
    if (!toTop) return;
    const on = phone && y > window.innerHeight * 1.5;
    toTop.hidden = !on;
    if (!on) return;
    // ride up with the footer instead of covering it (but never into the chip row)
    const over = foot ? window.innerHeight - foot.getBoundingClientRect().top : 0;
    const max = window.innerHeight - barH - toTop.offsetHeight - 36;
    toTop.style.setProperty('--lift', `${Math.round(Math.max(0, Math.min(over, max)))}px`);
  }
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; onScroll(); });
  };

  toTop?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }));
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue, { passive: true });
  const refresh = () => { measure(); queue(); };
  if (typeof ResizeObserver === 'function') new ResizeObserver(refresh).observe(header); // text size, language, rotation
  if (mq.addEventListener) mq.addEventListener('change', refresh); else mq.addListener?.(refresh);
  refresh();
}
