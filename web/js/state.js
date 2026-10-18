// Shared application state and a tiny event bus.
import { levelNum } from './util.js';

export const state = {
  lang: 'zh-Hant',
  theme: 'dark',
  data: {
    alerts: null, meta: null, flights: null, world: null, countries: null, epidemics: null,
    warnings: null, // MOFA (BOCA) / MAC travel warnings, loaded after the critical data
    worldNames: new Map(),
  },
  epidemicsStatus: 'idle', // idle | loading | ready | error
  byCountry: new Map(), // iso -> epidemic items (date desc)
  selected: null,
  filter: new Set(), // CDC levels to highlight; empty = all
  layer: 'cdc', // map colouring: 'cdc' (CDC health advisories) | 'mofa' (MOFA/MAC travel warnings)
  wfilter: new Set(), // travel-warning levels to highlight (MOFA layer); empty = all
  flightsOn: true,
  spotlight: { iso: null, playing: true },
  mapPinned: false, // true while an overlay owns the map view (outbreak route watch): the tour does not move the map
  fps: 0,
  errors: [],
};

const bus = new EventTarget();
export function on(type, fn) {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
}
export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

export function levelOf(iso) {
  return levelNum(state.data.alerts?.countries?.[iso]?.max_level); // always 0..3
}
/** MOFA/MAC travel-warning entry of a country (null when none is published). */
export function warningOf(iso) {
  return state.data.warnings?.countries?.[iso] || null;
}
/** Whole-country travel-warning level, always 0..4 (0 = none issued / regional only). */
export function warnLevel(iso) {
  const l = Number(warningOf(iso)?.level);
  return Number.isInteger(l) && l >= 0 && l <= 4 ? l : 0;
}
/** Highest level of a regional warning when it is above the whole-country level, else 0. */
export function warnPartial(iso) {
  const l = Number(warningOf(iso)?.max_level);
  return Number.isInteger(l) && l > warnLevel(iso) && l <= 4 ? l : 0;
}
export const mofaMode = () => state.layer === 'mofa' && !!state.data.warnings;

export function alertsOf(iso) {
  return state.data.alerts?.countries?.[iso]?.alerts || [];
}
/**
 * Group a country's advisories by (disease, level): sub-national rows of the same disease/level
 * (e.g. 新型A型流感 L2 in many Chinese provinces) collapse into one group.
 * Groups are sorted by level desc, then newest effective date desc.
 */
export function groupAlerts(iso) {
  const byKey = new Map();
  for (const a of alertsOf(iso)) {
    const level = levelNum(a.level); // always 0..3, safe to interpolate into class names
    const k = `${level}|${a.disease}`;
    if (!byKey.has(k)) byKey.set(k, { disease: a.disease, level, effective: a.effective || '', rows: [] });
    const g = byKey.get(k);
    g.rows.push(a);
    if ((a.effective || '') > g.effective) g.effective = a.effective;
  }
  const groups = [...byKey.values()];
  for (const g of groups) {
    g.rows.sort((x, y) => (y.effective || '').localeCompare(x.effective || ''));
    g.areas = g.rows.filter((r) => r.area_zh || r.area_en);
    g.national = g.rows.some((r) => !(r.area_zh || r.area_en));
  }
  groups.sort((a, b) => b.level - a.level || b.effective.localeCompare(a.effective));
  return groups;
}

export function routesTo(iso) {
  return (state.data.flights?.routes || []).filter((r) => r.country === iso);
}
