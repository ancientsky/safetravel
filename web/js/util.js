// Small DOM / text / date helpers shared by all modules.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

// Source text sometimes carries CJK radical look-alikes; normalise for display.
export function clean(text) {
  // Fold only the radical blocks; full NFKC would turn CJK full-width punctuation into ASCII.
  return String(text ?? '')
    .replace(/[\u2F00-\u2FDF]/g, (ch) => ch.normalize('NFKC'))
    .replace(/⺠/g, '民')
    .replace(/⻔/g, '門')
    .trim();
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function debounce(fn, ms) {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
}

export const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Parse YYYY-MM-DD as a UTC midnight Date (dates in the data are calendar days). */
export function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

/** Today's calendar day in Asia/Taipei, as a UTC-midnight Date. */
export function todayTaipei(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  return parseDay(parts);
}

/** Elapsed calendar time between a YYYY-MM-DD date and today (Taipei). */
export function elapsed(dateStr, now = new Date()) {
  const d = parseDay(dateStr);
  const t = todayTaipei(now);
  if (!d || !t) return null;
  const days = Math.round((t - d) / 86400000);
  let months = (t.getUTCFullYear() - d.getUTCFullYear()) * 12 + (t.getUTCMonth() - d.getUTCMonth());
  if (t.getUTCDate() < d.getUTCDate()) months -= 1;
  return { days, months: Math.max(0, months) };
}

export function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

/** Weighted random pick; `weight(item)` must be >= 0. */
export function weightedPick(items, weight, rnd = Math.random) {
  let total = 0;
  for (const it of items) total += weight(it);
  if (total <= 0) return items[Math.floor(rnd() * items.length)];
  let r = rnd() * total;
  for (const it of items) {
    r -= weight(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

export function truncate(text, n) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/** Data-sourced links: only https Taiwan CDC pages may become an href; anything else → ''. */
export function safeUrl(u) {
  try {
    const x = new URL(String(u));
    const host = x.hostname.toLowerCase();
    if (x.protocol === 'https:' && (host === 'cdc.gov.tw' || host.endsWith('.cdc.gov.tw'))) return x.href;
  } catch { /* not a URL */ }
  return '';
}

/** Advisory level coerced to 0..3 before it is interpolated into markup. */
export function levelNum(level) {
  const lv = +level;
  return [1, 2, 3].includes(lv) ? lv : 0;
}

/** Finite number or a fallback, before it is interpolated into markup. */
export function finiteNum(v, fallback = 0) {
  return Number.isFinite(+v) ? +v : fallback;
}
