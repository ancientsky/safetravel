// Place search shared by index.html and trip.html: airports (IATA code, Chinese / English name, city) and cities,
// each resolving to its country. Loaded on first use of a search box, never at page load:
//   data/places.json    airports + cities with Chinese names (pipeline/places.py, ~35 KB)
//   data/airports.json  every airport with an IATA code: English name, city, country (~165 KB over gzip)

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\-‐-―_.,'’()（）・·]+/g, '');
const CJK = /[㐀-鿿]/;

let loading = null;
let places = null; // [{ code, iso, zh, en, name, kind: 'airport' | 'city', keys: [normalised strings] }]

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** Start loading the place index (idempotent); resolves when search can include places. */
export function loadPlaces() {
  if (!loading) {
    loading = Promise.all([getJSON('data/places.json').catch(() => null), getJSON('data/airports.json').catch(() => null)])
      .then(([pl, ap]) => {
        const byCode = new Map();
        const list = [];
        for (const p of pl?.places || []) {
          if (!/^[A-Z]{2}$/.test(p.iso || '')) continue;
          const e = { code: p.code || '', iso: p.iso, zh: p.zh || '', en: p.en || '', name: '', kind: p.code ? 'airport' : 'city' };
          list.push(e);
          if (e.code) byCode.set(e.code, e);
        }
        for (const [code, a] of Object.entries(ap || {})) {
          const iso = String(a.country || '').toUpperCase();
          if (!/^[A-Z]{3}$/.test(code) || !/^[A-Z]{2}$/.test(iso)) continue;
          const e = byCode.get(code);
          if (e) { e.name = a.name || ''; e.city = a.city || ''; continue; }
          list.push({ code, iso, zh: '', en: a.city || a.name || '', name: a.name || '', city: a.city || '', kind: 'airport' });
        }
        // an airport also answers to the Chinese name of its city ("曼谷" -> BKK, DMK) when that city is a known one
        const cityZh = new Map(list.filter((e) => e.kind === 'city' && e.en).map((e) => [`${e.iso}|${norm(e.en)}`, e.zh]));
        for (const e of list) {
          const alias = e.kind === 'airport' && e.city ? cityZh.get(`${e.iso}|${norm(e.city)}`) : '';
          e.keys = [...new Set([e.code, e.zh, e.en, e.name, e.city, alias].filter(Boolean).map(norm))];
        }
        places = list;
        return places;
      });
  }
  return loading;
}

export const placesReady = () => !!places;

/**
 * Places matching q, best first: [{ place, score }] with score 0 exact (or exact IATA code), 1 prefix, 2 substring.
 * Latin queries need 2+ characters (3+ for substring matches) so a single letter does not list thousands of airports.
 */
export function findPlaces(q, max = 6) {
  if (!places) return [];
  const s = norm(q);
  if (!s) return [];
  const cjk = CJK.test(s);
  if (!cjk && s.length < 2) return [];
  const out = [];
  for (const p of places) {
    let best = Infinity;
    if (p.code && p.code.toLowerCase() === s) best = 0;
    else {
      for (const k of p.keys) {
        if (k === s) { best = 0; break; }
        if (k.startsWith(s)) best = Math.min(best, 1);
        else if ((cjk || s.length >= 3) && k.includes(s)) best = Math.min(best, 2);
      }
    }
    // airports with a Chinese name are the ones that matter for Taiwan travellers: rank them first
    if (best < Infinity) out.push({ place: p, score: best + (p.zh ? 0 : 0.4) });
  }
  out.sort((a, b) => a.score - b.score || (a.place.code ? 0 : 1) - (b.place.code ? 0 : 1) || a.place.en.localeCompare(b.place.en));
  return out.slice(0, max);
}

/** Display name of a place in the current language (Chinese name may be missing: English then). */
export function placeName(p, en) {
  return (en ? p.en || p.zh : p.zh || p.en) || p.code;
}
