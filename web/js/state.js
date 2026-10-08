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
export function routesTo(iso) {
  return (state.data.flights?.routes || []).filter((r) => r.country === iso);
}
