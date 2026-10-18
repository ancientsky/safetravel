// trip.html data layer: fetch helpers, link/level validation and the per-destination model.
import { clean, todayTaipei } from './util.js';

export async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

// Lazily loaded, cached once per page.
let textPromise = null;
let epiPromise = null;
export function loadWarningsText() {
  textPromise ||= getJSON('data/warnings-text.json').catch((e) => { textPromise = null; throw e; });
  return textPromise;
}
export function loadEpidemics() {
  epiPromise ||= getJSON('data/epidemics.json').catch((e) => { epiPromise = null; throw e; });
  return epiPromise;
}

const LINK_HOSTS = ['boca.gov.tw', 'mac.gov.tw', 'cdc.gov.tw'];
/** Data-sourced links: only https pages of BOCA, MAC or Taiwan CDC may become an href; anything else → ''. */
export function safeHref(u) {
  try {
    const x = new URL(String(u));
    const host = x.hostname.toLowerCase();
    if (x.protocol === 'https:' && !x.username && !x.password
      && LINK_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return x.href;
  } catch { /* not a URL */ }
  return '';
}

/** MOFA level 0..4, or null for "no nationwide level / not listed". */
export function mofaLv(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : null;
}
/** Taiwan CDC level 0..3. */
export function cdcLv(v) {
  const n = Number(v);
  return n === 1 || n === 2 || n === 3 ? n : 0;
}

export const REGIONS = ['AsiaPacific', 'AsiaMiddleEast', 'Europe', 'Africa', 'NorthAmerica', 'LatinAmerica', 'Other'];
const ISO_RE = /^[A-Z]{2}$/;
const SKIP = new Set(['TW', 'AQ']);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/**
 * One record per ISO code found in warnings.json, alerts.json or countries.json (minus TW / AQ).
 * `listed` = present in warnings or alerts (these make up the table); the rest are search-only.
 */
export function buildModel({ warnings, alerts, countries }) {
  const W = obj(warnings?.countries) || {};
  const A = obj(alerts?.countries) || {};
  const C = obj(countries) || {};
  const dests = new Map();
  for (const iso of new Set([...Object.keys(W), ...Object.keys(A), ...Object.keys(C)])) {
    if (!ISO_RE.test(iso) || SKIP.has(iso)) continue;
    const w = obj(W[iso]);
    const a = obj(A[iso]);
    const c = obj(C[iso]);
    const nameZh = tidyName(w?.name_zh || a?.name_zh || c?.zh || c?.en || iso);
    const nameEn = tidyName(w?.name_en || a?.name_en || c?.en || nameZh);
    let region = 'Other';
    if (w) region = w.source === 'mac' ? 'AsiaPacific' : (REGIONS.includes(w.region) ? w.region : 'Other');
    const mofa = w ? mofaLv(w.level) : null;
    const mofaMax = w ? mofaLv(w.max_level) : null;
    const areas = Array.isArray(w?.areas) ? w.areas.filter(obj) : [];
    const alertRows = Array.isArray(a?.alerts) ? a.alerts.filter(obj) : [];
    const local = alertRows.filter((x) => !x.global);
    dests.set(iso, {
      iso, nameZh, nameEn, region, w, a, c,
      listed: !!(w || a),
      source: w?.source === 'mac' ? 'mac' : 'mofa',
      mofa, mofaMax,
      // nationwide level is lower than an area's (or only areas are rated)
      partial: !!w && mofaMax != null && mofaMax > (mofa ?? 0),
      areas,
      cdc: a ? cdcLv(a.max_level) : 0,
      alerts: alertRows,
      local,
      diseases: [...new Set(local.map((x) => clean(x.disease)).filter(Boolean))],
      // search keys (NFKC, lower-case, 臺→台, no spaces)
      keys: [nameZh, nameEn, w?.name_zh, w?.name_en, a?.name_zh, a?.name_en, c?.zh, c?.en]
        .filter(Boolean).map(normKey),
    });
  }
  const list = [...dests.values()].filter((d) => d.listed);
  return { dests, list, warnings: obj(warnings), alerts: obj(alerts) };
}

// BOCA titles occasionally leak a trailing "(YYYY-MM-DD)" into a name.
const tidyName = (s) => clean(s).replace(/\s*[(（]\d{4}-\d{2}-\d{2}[)）]\s*$/, '');

export function normKey(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/臺/g, '台').replace(/[\s·・,，.'’()（）-]+/g, '');
}

/** YYYY-MM-DD of today (Taipei) shifted by -days / -months. */
export function dayAgo({ days = 0, months = 0 } = {}) {
  const d = todayTaipei();
  if (months) d.setUTCMonth(d.getUTCMonth() - months);
  if (days) d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
