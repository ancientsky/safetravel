// trip.html "旅遊醫學門診": Taiwan CDC's travel medicine contract hospitals (travelmed.json "clinics").
// City filter, "open in this session" (CDC lists morning / afternoon / evening sessions per weekday), M痘 vaccine,
// and "nearest to me" (the position stays in the browser). Each clinic shows a week grid, its next session,
// and call / website / map links. On wide screens a small Taiwan map locates them.
import { h } from './trip-dom.js';
import { t, isEn } from './trip-i18n.js';
import { loadTravelmed, getJSON, telHref, webHref, mapsHref } from './trip-data.js';
import { clean } from './util.js';
import { createMore } from './trip-more.js';

// session windows used for "open now" (CDC gives only 早 / 午 / 夜): 08:00-12:00, 13:30-17:30, 18:00-21:30
const SLOTS = [[480, 720], [810, 1050], [1080, 1290]];
const ZH = 'zh-Hant';
const PHONE_FIRST = 6; // clinics listed on a phone before "show all" (trip-more.js)

/** Day (0 = Monday) and minutes after midnight in Taipei. */
export function taipeiNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
  return { day: day < 0 ? 0 : day, min: Number(p.hour) * 60 + Number(p.minute) };
}

const isOpen = (c, day, slot) => typeof c.hours?.[day] === 'string' && c.hours[day][slot] === '1';

/** {kind: 'now'|'today'|'tomorrow'|'later'|'none', day, slot} */
export function clinicStatus(c, now = taipeiNow()) {
  if (!Array.isArray(c.hours) || !c.hours.some((x) => /1/.test(String(x)))) return { kind: 'none' };
  const cur = SLOTS.findIndex(([a, b]) => now.min >= a && now.min < b);
  if (cur >= 0 && isOpen(c, now.day, cur)) return { kind: 'now', day: now.day, slot: cur };
  for (let k = 0; k < 8; k += 1) {
    const day = (now.day + k) % 7;
    for (let s = 0; s < 3; s += 1) {
      if (k === 0 && now.min >= SLOTS[s][0]) continue;
      if (isOpen(c, day, s)) return { kind: k === 0 ? 'today' : k === 1 ? 'tomorrow' : 'later', day, slot: s };
    }
  }
  return { kind: 'none' };
}

function statusText(st) {
  const slot = st.slot != null ? t(`cl_slot_${st.slot}`) : '';
  if (st.kind === 'now') return t('cl_open_now', { slot });
  if (st.kind === 'today') return t('cl_today', { slot });
  if (st.kind === 'tomorrow') return t('cl_tomorrow', { slot });
  if (st.kind === 'later') return t('cl_next', { day: t(`cl_day_${st.day}`), slot });
  return t('cl_no_hours');
}

function km(a, b) {
  const R = 6371;
  const r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLon = r(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function weekGrid(c, now) {
  const open = [];
  const grid = h('div', { class: 'cl-week', role: 'img' });
  grid.append(h('span', { class: 'cl-wk-c' }));
  for (let d = 0; d < 7; d += 1) grid.append(h('span', { class: `cl-wk-d${d === now.day ? ' is-today' : ''}`, text: t(`cl_dshort_${d}`) }));
  for (let s = 0; s < 3; s += 1) {
    grid.append(h('span', { class: 'cl-wk-s', text: t(`cl_sshort_${s}`) }));
    for (let d = 0; d < 7; d += 1) {
      const on = isOpen(c, d, s);
      if (on) open.push(t('cl_dayslot', { day: t(`cl_day_${d}`), slot: t(`cl_slot_${s}`) }));
      const curr = d === now.day && now.min >= SLOTS[s][0] && now.min < SLOTS[s][1];
      grid.append(h('span', { class: `cl-wk-x${on ? ' on' : ''}${d === now.day ? ' is-today' : ''}${curr ? ' is-now' : ''}` }));
    }
  }
  grid.setAttribute('aria-label', open.length ? t('cl_week_label', { list: open.join(isEn() ? ', ' : '、') }) : t('cl_no_hours'));
  return grid;
}

/** root: the #clinics section. */
export function createClinics({ root }) {
  const state = { data: null, city: '', now: false, mpox: false, near: null, sel: null, failed: false, geoMsg: '' };
  const tools = root.querySelector('.cl-tools');
  const listEl = root.querySelector('.cl-list');
  const countEl = root.querySelector('.cl-count');
  const mapEl = root.querySelector('.cl-map');
  const more = createMore({ host: listEl, after: root.querySelector('.cl-body'), limit: PHONE_FIRST, testid: 'cl-more' });
  let mapApi = null;
  let started = false;

  function filtered(now) {
    let list = state.data?.clinics || [];
    if (state.city) list = list.filter((c) => c.city === state.city);
    if (state.mpox) list = list.filter((c) => c.mpox);
    if (state.now) list = list.filter((c) => clinicStatus(c, now).kind === 'now');
    if (state.near) {
      list = list.map((c) => ({ c, d: Number.isFinite(c.lat) ? km(state.near, c) : Infinity }))
        .sort((a, b) => a.d - b.d).map((x) => ({ ...x.c, _km: x.d }));
    }
    return list;
  }

  function cityName(zh) {
    const c = (state.data?.cities || []).find((x) => x.zh === zh);
    return clean(isEn() ? c?.en || zh : zh);
  }

  function renderTools() {
    const cities = state.data?.cities || [];
    const counts = new Map();
    for (const c of state.data?.clinics || []) counts.set(c.city, (counts.get(c.city) || 0) + 1);
    const sel = h('select', { id: 'cl-city', class: 'f-input cl-city', 'data-testid': 'cl-city' },
      h('option', { value: '', text: t('cl_city_all', { n: state.data?.clinics?.length || 0 }) }),
      cities.map((c) => h('option', { value: c.zh, text: `${cityName(c.zh)} (${counts.get(c.zh) || 0})` })));
    sel.value = state.city;
    sel.addEventListener('change', () => { state.city = sel.value; renderList(); });
    const toggle = (key, label, testid) => {
      const b = h('button', { type: 'button', class: 'cl-tg', 'aria-pressed': String(state[key]), 'data-testid': testid, text: label });
      b.addEventListener('click', () => { state[key] = !state[key]; b.setAttribute('aria-pressed', String(state[key])); renderList(); });
      return b;
    };
    const geo = h('button', { type: 'button', class: 'cl-tg cl-geo', 'aria-pressed': String(!!state.near), 'data-testid': 'cl-near' },
      h('span', { 'aria-hidden': 'true', text: '◎ ' }), t(state.near ? 'cl_near_on' : 'cl_near'));
    geo.addEventListener('click', () => {
      if (state.near) { state.near = null; state.geoMsg = ''; renderTools(); renderList(); return; }
      if (!navigator.geolocation) { state.geoMsg = t('cl_geo_unsupported'); renderTools(); return; }
      state.geoMsg = t('cl_geo_wait');
      renderTools();
      navigator.geolocation.getCurrentPosition((pos) => {
        state.near = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        state.geoMsg = t('cl_geo_ok');
        renderTools();
        renderList();
      }, () => {
        state.geoMsg = t('cl_geo_failed');
        renderTools();
      }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
    });
    tools.replaceChildren(...[
      h('div', { class: 'f-field' }, h('label', { for: 'cl-city', text: t('cl_city') }), sel),
      h('div', { class: 'cl-tgs', role: 'group', 'aria-label': t('cl_filters') },
        toggle('now', t('cl_f_now'), 'cl-now'),
        toggle('mpox', t('cl_f_mpox'), 'cl-mpox'),
        geo),
      state.geoMsg ? h('p', { class: 'cl-geo-msg', role: 'status', text: state.geoMsg }) : null,
    ].filter(Boolean));
  }

  function clinicCard(c, now) {
    const st = clinicStatus(c, now);
    const name = clean(isEn() ? c.name_en || c.name : c.name);
    const tel = telHref(c.tel);
    const web = webHref(c.url);
    const maps = mapsHref(c.lat, c.lon);
    const since = /^\d{4}-\d{2}-\d{2}$/.test(c.since || '') ? c.since : '';
    const isNew = since && (Date.now() - Date.parse(since)) < 365 * 864e5;
    const card = h('li', { class: `cl-card${state.sel === c.id ? ' is-sel' : ''}`, id: `cl-${c.id}`, 'data-id': c.id, 'data-testid': 'cl-card', tabindex: '-1' },
      h('div', { class: 'cl-top' },
        h('div', { class: 'cl-names' },
          h('h3', { class: 'cl-name', lang: isEn() && !c.name_en ? ZH : null, text: name }),
          isEn() && c.name_en ? h('p', { class: 'cl-alt', lang: ZH, text: clean(c.name) }) : null,
          h('p', { class: 'cl-meta' },
            h('span', { text: cityName(c.city) }),
            h('span', { lang: isEn() && !c.dept_en ? ZH : null, text: clean(isEn() ? c.dept_en || c.dept : c.dept) }),
            c._km != null && Number.isFinite(c._km) ? h('span', { class: 'cl-km', text: t('cl_km', { n: c._km < 10 ? c._km.toFixed(1) : Math.round(c._km) }) }) : null)),
        h('p', { class: `cl-st cl-st-${st.kind}`, 'data-testid': 'cl-status', text: statusText(st) })),
      h('div', { class: 'cl-mid' },
        weekGrid(c, now),
        h('div', { class: 'cl-badges' },
          c.mpox ? h('span', { class: 'cl-badge cl-b-mpox', text: t('cl_b_mpox') }) : null,
          /機場/.test(c.name) ? h('span', { class: 'cl-badge', text: t('cl_b_airport') }) : null,
          isNew ? h('span', { class: 'cl-badge cl-b-new', text: t('cl_b_new', { d: since }) }) : null)),
      h('p', { class: 'cl-addr', lang: ZH, text: clean(c.addr) }),
      h('div', { class: 'cl-acts' },
        tel ? h('a', { class: 'btn cl-act', href: tel }, h('span', { 'aria-hidden': 'true', text: '☎ ' }), clean(c.tel)) : null,
        web ? h('a', { class: 'btn cl-act', href: web, target: '_blank', rel: 'noopener noreferrer', text: t('cl_web') }) : null,
        maps ? h('a', { class: 'btn cl-act', href: maps, target: '_blank', rel: 'noopener noreferrer', text: t('cl_maps') }) : null));
    card.addEventListener('mouseenter', () => mapApi?.hover(c.id));
    card.addEventListener('mouseleave', () => mapApi?.hover(null));
    return card;
  }

  function renderList() {
    if (!state.data) return;
    const now = taipeiNow();
    const list = filtered(now);
    countEl.textContent = t('cl_count', { n: list.length });
    if (!list.length) {
      const reset = h('button', { type: 'button', class: 'btn btn-ghost', text: t('cl_reset') });
      reset.addEventListener('click', () => { Object.assign(state, { city: '', now: false, mpox: false }); renderTools(); renderList(); });
      listEl.replaceChildren(h('li', { class: 'cl-empty' }, h('p', { text: state.now ? t('cl_empty_now') : t('cl_empty') }), reset));
      more.update([]);
    } else {
      const cards = list.map((c) => clinicCard(c, now));
      listEl.replaceChildren(...cards);
      more.update(cards);
    }
    mapApi?.update(new Set(list.map((c) => c.id)), state.near);
  }

  function select(id) {
    state.sel = id;
    listEl.querySelectorAll('.cl-card').forEach((el) => el.classList.toggle('is-sel', el.dataset.id === id));
    const el = listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    more.reveal(el); // a clinic after the first few on a narrow screen
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); el.focus({ preventScroll: true }); }
  }

  async function initMap() {
    if (!mapEl || window.innerWidth < 1000 || !window.d3 || !window.topojson) return;
    try {
      const world = await getJSON('data/world.json');
      mapApi = drawMap(mapEl, world, state.data.clinics, { onPick: select });
      mapEl.hidden = false;
      renderList();
    } catch (e) {
      console.warn('trip: clinic map unavailable', e);
    }
  }

  async function start() {
    if (started) return;
    started = true;
    try {
      state.data = await loadTravelmed();
      if (!Array.isArray(state.data?.clinics) || !state.data.clinics.length) throw new Error('no clinics');
      root.querySelector('.cl-sub').textContent = t('cl_sub', { n: state.data.clinics.length });
      renderTools();
      renderList();
      initMap();
      setInterval(() => { if (!document.hidden) renderList(); }, 5 * 60_000);
    } catch (e) {
      console.warn('trip: travelmed.json unavailable', e);
      state.failed = true;
      listEl.replaceChildren(h('li', { class: 'cl-empty', text: t('cl_failed') }));
    }
  }

  return {
    start,
    render() {
      if (!state.data) return;
      root.querySelector('.cl-sub').textContent = t('cl_sub', { n: state.data.clinics.length });
      renderTools();
      renderList();
      mapApi?.relabel();
    },
    focus() {
      root.scrollIntoView({ behavior: 'smooth', block: 'start' });
      root.querySelector('#cl-h')?.focus({ preventScroll: true });
    },
  };
}

// ---------------------------------------------------------------- locator map (d3 + topojson, wide screens only)
function drawMap(box, world, clinics, { onPick }) {
  const { d3, topojson } = window;
  const W = 300;
  const H = 420;
  const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('class', 'cl-svg').attr('role', 'group');
  const obj = world.objects.countries;
  const tw = obj.geometries.filter((g) => g.id === 'TW');
  const land = topojson.feature(world, { type: 'GeometryCollection', geometries: tw });
  // main island + Penghu fill the frame; Kinmen and Matsu get small insets
  const frame = { type: 'MultiPoint', coordinates: [[119.3, 21.85], [122.05, 25.35]] };
  const proj = d3.geoNaturalEarth1().rotate([-120.8, 0]).fitExtent([[16, 14], [W - 16, H - 14]], frame);
  const path = d3.geoPath(proj);
  svg.append('path').attr('class', 'cl-land').attr('d', path(land));
  const insets = [
    { key: 'kinmen', lon: [118.15, 118.55], lat: [24.35, 24.55], x: 10, y: 10, w: 70, h: 44 },
    { key: 'matsu', lon: [119.85, 120.55], lat: [25.9, 26.42], x: 10, y: 62, w: 70, h: 44 },
  ];
  const insetOf = (c) => insets.find((b) => c.lon >= b.lon[0] && c.lon <= b.lon[1] && c.lat >= b.lat[0] && c.lat <= b.lat[1]);
  const projs = new Map();
  for (const b of insets) {
    const p = d3.geoNaturalEarth1().rotate([-120.8, 0]).fitExtent([[b.x + 4, b.y + 4], [b.x + b.w - 4, b.y + b.h - 14]],
      { type: 'MultiPoint', coordinates: [[b.lon[0], b.lat[0]], [b.lon[1], b.lat[1]]] });
    projs.set(b.key, p);
    const g = svg.append('g').attr('class', 'cl-inset');
    g.append('rect').attr('x', b.x).attr('y', b.y).attr('width', b.w).attr('height', b.h).attr('rx', 6);
    g.append('clipPath').attr('id', `cl-clip-${b.key}`).append('rect').attr('x', b.x).attr('y', b.y).attr('width', b.w).attr('height', b.h);
    g.append('path').attr('class', 'cl-land').attr('clip-path', `url(#cl-clip-${b.key})`).attr('d', d3.geoPath(p)(land));
    b.label = g.append('text').attr('class', 'cl-inset-t').attr('x', b.x + b.w / 2).attr('y', b.y + b.h - 4).attr('text-anchor', 'middle');
  }
  const xy = (c) => {
    const b = insetOf(c);
    return (b ? projs.get(b.key) : proj)([c.lon, c.lat]);
  };
  const dots = svg.append('g').selectAll('circle')
    .data(clinics.filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon)))
    .join('circle')
    .attr('class', (c) => `cl-dot${c.mpox ? ' mpox' : ''}`)
    .attr('r', 5.5)
    .attr('cx', (c) => xy(c)[0])
    .attr('cy', (c) => xy(c)[1])
    .attr('tabindex', 0)
    .attr('role', 'button')
    .on('click', (ev, c) => onPick(c.id))
    .on('keydown', (ev, c) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onPick(c.id); } });
  dots.append('title');
  const me = svg.append('circle').attr('class', 'cl-me').attr('r', 6).attr('hidden', true);
  function relabel() {
    insets[0].label.text(t('cl_inset_kinmen'));
    insets[1].label.text(t('cl_inset_matsu'));
    dots.attr('aria-label', (c) => clean(isEn() ? c.name_en || c.name : c.name));
    dots.select('title').text((c) => clean(isEn() ? c.name_en || c.name : c.name));
    svg.attr('aria-label', t('cl_map_label'));
  }
  relabel();
  return {
    relabel,
    update(ids, near) {
      dots.classed('is-off', (c) => !ids.has(c.id));
      if (near && near.lon > 119 && near.lon < 122.2 && near.lat > 21.8 && near.lat < 25.4) {
        const [x, y] = proj([near.lon, near.lat]);
        me.attr('cx', x).attr('cy', y).attr('hidden', null);
      } else {
        me.attr('hidden', true);
      }
    },
    hover(id) { dots.classed('is-hover', (c) => c.id === id); },
  };
}
