// Pure weather helpers shared by trip.html (trip-weather.js, trip-wxmap.js) and the main map overlay (weather.js):
// weather.json validation, temperature colour classes, marker priority and the greedy declutter pass.
// No DOM and no i18n here, so both pages can use it with their own dictionaries.
import { clean } from './util.js';

export const ICONS = ['sun', 'partly', 'cloud', 'overcast', 'showers', 'rain', 'thunder', 'sleet', 'snow', 'fog'];
const ICON_SET = new Set(ICONS);
/** Icons that mean rain (for "rain on N days"). */
export const WET = new Set(['rain', 'showers', 'thunder', 'sleet']);
export const DATASET_URL = 'https://opendata.cwa.gov.tw/dataset/forecast/F-C0032-007';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const geo = (v, lim) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim ? v : null);
const day = (s) => (/^\d{4}-\d{2}-\d{2}/.exec(String(s || '')) || [''])[0];
const ISO_RE = /^[A-Z]{2}$/;

/** https page on cwa.gov.tw, else ''. */
export function cwaHref(u) {
  try {
    const x = new URL(String(u));
    const host = x.hostname.toLowerCase();
    if (x.protocol === 'https:' && !x.username && !x.password && (host === 'cwa.gov.tw' || host.endsWith('.cwa.gov.tw'))) return x.href;
  } catch { /* not a URL */ }
  return '';
}

/** Validate weather.json into the shape both pages rely on (bad rows are dropped, never trusted). */
export function normalizeWeather(raw) {
  const src = obj(raw?.source) || {};
  const regions = (Array.isArray(raw?.regions) ? raw.regions : []).map(obj).filter(Boolean)
    .map((r) => ({ id: String(r.id ?? ''), zh: clean(r.zh), en: clean(r.en) }))
    .filter((r) => /^[\w-]{1,32}$/.test(r.id));
  const order = new Map(regions.map((r, i) => [r.id, i]));
  const cities = [];
  (Array.isArray(raw?.cities) ? raw.cities : []).forEach((c, idx) => {
    if (!obj(c) || !Array.isArray(c.days)) return;
    const days = c.days.map(obj).filter(Boolean).map((d) => {
      let max = num(d.max);
      let min = num(d.min);
      if (max != null && min != null && min > max) [max, min] = [min, max];
      return { date: day(d.date), icon: ICON_SET.has(d.icon) ? d.icon : 'cloud', zh: clean(d.wx_zh), en: clean(d.wx_en), max, min };
    }).filter((d) => d.date);
    const nameZh = clean(c.name_zh);
    const nameEn = clean(c.name_en);
    if (!days.length || !(nameZh || nameEn)) return;
    cities.push({
      id: /^[\w-]{1,16}$/.test(String(c.id ?? '')) ? String(c.id) : `c${idx}`,
      nameZh: nameZh || nameEn,
      nameEn: nameEn || nameZh,
      iso: ISO_RE.test(String(c.iso ?? '')) ? c.iso : null,
      region: order.has(c.region) ? c.region : '',
      lat: geo(c.lat, 90),
      lon: geo(c.lon, 180),
      days,
      idx,
    });
  });
  if (!cities.length) throw new Error('weather.json has no usable cities');
  // CWA's region order, then CWA's city order
  cities.sort((a, b) => (order.get(a.region) ?? 99) - (order.get(b.region) ?? 99) || a.idx - b.idx);
  if (cities.some((c) => !c.region)) regions.push({ id: '', zh: '其他', en: 'Other' });

  const temps = cities.flatMap((c) => c.days.flatMap((d) => [d.max, d.min])).filter((v) => v != null);
  let lo = temps.length ? Math.floor(Math.min(...temps) / 5) * 5 : 0;
  let hi = temps.length ? Math.ceil(Math.max(...temps) / 5) * 5 : 30;
  if (hi - lo < 10) { lo -= 5; hi += 5; }
  return {
    issued: typeof src.issued === 'string' ? src.issued : '',
    url: cwaHref(src.url) || DATASET_URL,
    regions,
    days: cities[0].days.map((d) => d.date),
    cities,
    scale: { lo, hi },
  };
}

// ---------------------------------------------------------------- temperatures
/** Typographic minus for sub-zero values. */
export const minus = (v) => String(v).replace('-', '−');
/** "24°" / "−3°" / "–" for a °C value (optionally converted to °F). */
export function degree(c, unit = 'C') {
  if (c == null) return '–';
  const v = unit === 'F' ? Math.round((c * 9) / 5 + 32) : c;
  return `${minus(v)}°`;
}

// buckets (°C) → CSS classes .wxk-* that mix the same ramp colours on both pages
const BUCKETS = [-10, -5, 0, 5, 10, 14, 17, 20, 24, 27, 30, 34, 38];
export function tempClass(c) {
  if (c == null) return 'wxk-na';
  let best = BUCKETS[0];
  for (const b of BUCKETS) if (Math.abs(c - b) < Math.abs(c - best)) best = b;
  return `wxk-${best < 0 ? `m${-best}` : best}`;
}

// ---------------------------------------------------------------- map markers
// placed first when space is short (well-known destinations for Taiwanese travellers); then CWA's order
const MAJOR = [
  'Tokyo', 'Seoul', 'Hong Kong', 'Bangkok', 'Singapore', 'Shanghai', 'Beijing', 'Manila', 'Ho Chi Minh City', 'Kuala Lumpur',
  'Jakarta', 'Sydney', 'Auckland', 'New Delhi', 'Kathmandu', 'Moscow', 'Istanbul', 'London', 'Paris', 'Rome', 'Frankfurt', 'Madrid',
  'Cairo', 'Johannesburg', 'New York', 'Los Angeles', 'San Francisco', 'Vancouver', 'Toronto', 'Honolulu', 'Guam', 'Mexico City',
  'Rio de Janeiro', 'Buenos Aires', 'Lima', 'Santiago', 'Osaka', 'Guangzhou', 'Vladivostok', 'Perth', 'Stockholm', 'Athens',
];
/** Placement priority of a city (lower = placed first). */
export function cityRank(c) {
  const i = MAJOR.indexOf(c.nameEn);
  return i < 0 ? MAJOR.length + c.idx : i;
}

/** Keyboard order: CWA region, then west → east as drawn on a map centred on `centreLon`. */
export function keyboardOrder(cities, regions, centreLon = 155) {
  const regionIdx = new Map(regions.map((r, i) => [r.id, i]));
  const fromLeft = (lon) => ((((lon - centreLon + 540) % 360) + 360) % 360);
  return [...cities].sort((a, b) => (regionIdx.get(a.region) ?? 99) - (regionIdx.get(b.region) ?? 99) || fromLeft(a.lon) - fromLeft(b.lon));
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Greedy screen-space label placement. `items` are in priority order and carry
 * { px, py, vis, wS, wL } (point, visible?, short pill width, named pill width); each gets
 * { full, named, ox, oy } (pill offset from the point). Pills never overlap each other, any other
 * visible point or an obstacle rect, and stay inside `bounds`. Pass 1 places short pills (icon +
 * temperature), pass 2 upgrades to the named pill where it still fits. Dots get the named pill
 * position for hover / focus.
 */
export function declutter(items, {
  bounds, obstacles = [], pillH = 22, gap = 6, dotPad = 6,
}) {
  const { x0, y0, x1, y1 } = bounds;
  const pts = [];
  for (const m of items) if (m.vis) pts.push({ m, x: m.px - dotPad, y: m.py - dotPad, w: dotPad * 2, h: dotPad * 2 });
  const cands = (w) => [[-w / 2, -gap - pillH], [gap, -pillH / 2], [-gap - w, -pillH / 2], [-w / 2, gap]];
  const placed = [];
  const tryPlace = (m, w) => {
    for (const [ox, oy] of cands(w)) {
      const r = { x: m.px + ox - 1, y: m.py + oy - 1, w: w + 2, h: pillH + 2 };
      if (r.x < x0 || r.y < y0 || r.x + r.w > x1 || r.y + r.h > y1) continue;
      if (placed.some((q) => q.m !== m && overlaps(r, q.r))) continue;
      if (pts.some((q) => q.m !== m && overlaps(r, q))) continue;
      if (obstacles.some((q) => overlaps(r, q))) continue;
      return { r, ox, oy };
    }
    return null;
  };
  for (const m of items) {
    m.full = false;
    m.named = false;
    const hit = m.vis ? tryPlace(m, m.wS) : null;
    if (hit) {
      placed.push({ m, r: hit.r });
      Object.assign(m, { full: true, ox: hit.ox, oy: hit.oy });
    }
  }
  for (const q of placed) {
    const hit = tryPlace(q.m, q.m.wL);
    if (hit) {
      q.r = hit.r;
      Object.assign(q.m, { named: true, ox: hit.ox, oy: hit.oy });
    }
  }
  for (const m of items) {
    if (m.full) continue;
    m.named = true;
    [m.ox, m.oy] = cands(m.wL)[m.py - pillH - gap < y0 ? 3 : 0];
  }
  return items;
}
