// Shared application state and a tiny event bus.

export const state = {
  lang: 'zh-Hant',
  theme: 'dark',
  data: {
    alerts: null, meta: null, flights: null, world: null, countries: null, epidemics: null,
    worldNames: new Map(),
  },
  epidemicsStatus: 'idle', // idle | loading | ready | error
  byCountry: new Map(), // iso -> epidemic items (date desc)
  selected: null,
  filter: new Set(), // levels to highlight; empty = all
  flightsOn: true,
  spotlight: { iso: null, playing: true },
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
  return state.data.alerts?.countries?.[iso]?.max_level || 0;
}
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
    const k = `${a.level}|${a.disease}`;
    if (!byKey.has(k)) byKey.set(k, { disease: a.disease, level: a.level, effective: a.effective || '', rows: [] });
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
