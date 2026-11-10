// Place search shared by index.html and trip.html: airports (IATA code, Chinese / English name, city) and cities,
// each resolving to its country. Loaded on first use of a search box, never at page load:
//   data/places.json    airports + cities with Chinese names (pipeline/places.py, ~35 KB)
//   data/airports.json  every airport with an IATA code: English name, city, country (~165 KB over gzip)

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\-‐-―_.,'’()（）・·]+/g, '');
const CJK = /[㐀-鿿]/;

let loading = null;
let places = null; // [{ code, iso, zh, en, name, alias, kind: 'airport' | 'city', keys: [normalised strings] }]
let airportsByCode = new Map();

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
          const alias = Array.isArray(p.alias) ? p.alias.filter((a) => typeof a === 'string') : [];
          const e = { code: p.code || '', iso: p.iso, zh: p.zh || '', en: p.en || '', name: '', alias, kind: p.code ? 'airport' : 'city' };
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
          e.keys = [...new Set([e.code, e.zh, e.en, e.name, e.city, alias, ...(e.alias || [])].filter(Boolean).map(norm))];
          if (e.code) byCode.set(e.code, e);
        }
        airportsByCode = byCode;
        places = list;
        return places;
      });
  }
  return loading;
}

export const placesReady = () => !!places;

/**
 * Does the airport with this IATA code answer to q (code, Chinese / English name, city, alias: "名古屋" or "Nagoya"
 * for NGO 中部)? Same rules as findPlaces (Latin: prefix under 3 letters); false until loadPlaces() has resolved.
 */
export function airportMatches(code, q) {
  const s = norm(q);
  const e = airportsByCode.get(String(code || '').toUpperCase());
  if (!e || !s) return false;
  const cjk = CJK.test(s);
  if (!cjk && s.length < 2) return false;
  return e.keys.some((k) => (cjk || s.length >= 3 ? k.includes(s) : k.startsWith(s)));
}

// Names people type that are not the official short name in the data (both languages).
export const COUNTRY_ALIASES = {
  US: ['usa', 'u.s.', 'u.s.a.', 'america', 'united states of america', 'the states', '美利堅'],
  GB: ['uk', 'u.k.', 'britain', 'great britain', 'england', 'scotland', 'wales', 'northern ireland', '英格蘭', '蘇格蘭', '威爾斯', '大不列顛'],
  AE: ['uae', 'u.a.e.', 'emirates', '阿聯', '阿聯酋', '阿拉伯聯合酋長國'],
  KR: ['korea', 'rok', 'republic of korea', '南韓', '大韓民國'],
  KP: ['dprk', '朝鮮', '北朝鮮'],
  CN: ['china', 'prc', 'mainland china', '中國', '大陸', '中華人民共和國'],
  TR: ['turkey', 'turkiye'],
  NL: ['holland', 'the netherlands'],
  CZ: ['czech republic', 'czech'],
  MM: ['burma'],
  CI: ['ivory coast', 'cote divoire'],
  RU: ['russian federation', '俄國'],
  VN: ['viet nam'],
  LA: ['lao', 'lao pdr'],
  CD: ['drc', 'dr congo', 'congo kinshasa', '民主剛果', '剛果（金）'],
  CG: ['congo brazzaville', '剛果（布）'],
  AU: ['澳大利亞', '澳洲'],
  NZ: ['新西蘭'],
  SA: ['saudi', 'ksa', '沙烏地', '沙特'],
  PH: ['the philippines'],
  TH: ['siam'],
  SZ: ['swaziland'],
  MK: ['macedonia'],
  CV: ['cape verde'],
  TL: ['east timor', '東帝汶'],
  PS: ['palestine', '巴勒斯坦'],
  VA: ['vatican', '梵蒂岡'],
};
// Common destinations from Taiwan: among equally good matches these come first ("ind" → India / Indonesia first).
export const POPULAR_ISO = ['JP', 'KR', 'TH', 'VN', 'CN', 'HK', 'MO', 'PH', 'ID', 'MY', 'SG', 'KH', 'IN', 'US', 'CA', 'AU', 'GB', 'FR', 'DE', 'IT', 'ES', 'TR', 'AE', 'NZ'];
export const popRank = (iso) => { const i = POPULAR_ISO.indexOf(iso); return i < 0 ? POPULAR_ISO.length : i; };

/**
 * Rank of a place among search results that also hold countries (exact 0, prefix 1, inside 2): exact name 0.5,
 * prefix 1.5, inside 2.5. A three-letter airport code only outranks a country that starts with those letters when it
 * was typed as a code, in capitals: "jap" means Japan (not JAP Chacarita), "ind" India or Indonesia (not IND
 * Indianapolis); "NRT" still goes straight to Narita. score = findPlaces' score.
 */
export function placeRank(place, score, q) {
  const s = norm(q);
  const code = String(place.code || '').toLowerCase();
  const byCodeOnly = !!code && code === s && !place.keys.some((k) => k === s && k !== code);
  return byCodeOnly && !/^[A-Z]{3}$/.test(String(q).trim()) ? 1.3 + (score % 1) : score + 0.5;
}

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
