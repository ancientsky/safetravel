// SVG world map: advisory-level choropleth, hover/selection effects, zoom & fly-to.
import { state, emit, levelOf, alertsOf, routesTo, groupAlerts } from './state.js';
import { t, countryName, countryAltName, levelShort, badge, fmtNum } from './i18n.js';
import { showTip, moveTip, hideTip } from './tooltip.js';
import { esc, clamp, reducedMotion } from './util.js';

const d3 = window.d3;
const topojson = window.topojson;

// Pacific-centred so every TPE route draws without crossing the map edge.
const ROTATE = [-155, 0];

export function createMap({ svgEl, onOpen, getInsets }) {
  const svg = d3.select(svgEl);
  const projection = d3.geoNaturalEarth1().rotate(ROTATE).precision(0.3);
  const path = d3.geoPath(projection);
  let width = 0;
  let height = 0;
  let transform = d3.zoomIdentity;
  const zoomListeners = new Set();
  const resizeListeners = new Set();

  svg.attr('aria-label', t('map_label'));
  svg.append('defs').html(`
    <radialGradient id="ocean-grad" cx="50%" cy="42%" r="70%">
      <stop offset="0%"/>
      <stop offset="100%"/>
    </radialGradient>`);

  const gZoom = svg.append('g').attr('class', 'zoom-layer');
  const sphere = gZoom.append('path').attr('class', 'sphere').datum({ type: 'Sphere' });
  const graticule = gZoom.append('path').attr('class', 'graticule').datum(d3.geoGraticule10());
  const gCountries = gZoom.append('g').attr('class', 'countries');
  const gFx = gZoom.append('g').attr('class', 'fx').attr('aria-hidden', 'true');
  const hoverOutline = gFx.append('path').attr('class', 'outline hover-outline');
  const gDots = gZoom.append('g').attr('class', 'flight-dots');

  // Animated effects live in separate overlay elements so the compositor can animate their
  // opacity/transform without repainting the (large) map SVG: one full-size <svg> per effect that
  // mirrors the zoom transform, plus HTML "pins" positioned in screen pixels.
  const fxLayer = document.createElement('div');
  fxLayer.className = 'fx-layer';
  fxLayer.setAttribute('aria-hidden', 'true');
  fxLayer.innerHTML = `
    <svg class="fx-svg fx-danger"><g class="zt"></g></svg>
    <svg class="fx-svg fx-homeglow"><g class="zt"><path class="home-glow"/></g></svg>
    <svg class="fx-svg fx-sel" hidden><g class="zt"><path class="sel-outline"/></g></svg>
    <svg class="fx-svg fx-spot" hidden><g class="zt"><path class="spot-outline"/></g></svg>
    <div class="fx-pin fx-homemark"><span class="home-ring"></span><span class="home-dot"></span><span class="home-label"></span></div>
    <div class="fx-pin fx-reticle" hidden>
      <svg class="ret-static" viewBox="-50 -50 100 100"><circle r="34" class="ret-c2"/>
        <path d="M-44 0H-28M28 0H44M0 -44V-28M0 28V44" class="ret-x"/>
        <path d="M-30 -30h10M-30 -30v10M30 -30h-10M30 -30v10M-30 30h10M-30 30v-10M30 30h-10M30 30v-10" class="ret-corner"/></svg>
      <svg class="ret-spin" viewBox="-50 -50 100 100"><circle r="22" class="ret-c1"/></svg>
    </div>`;
  svgEl.after(fxLayer);
  const fxSvgs = Array.from(fxLayer.querySelectorAll('.fx-svg'));
  const fxGroups = fxSvgs.map((s) => s.querySelector('.zt'));
  const dangerG = d3.select(fxLayer.querySelector('.fx-danger .zt'));
  const homeGlow = fxLayer.querySelector('.home-glow');
  const selSvg = fxLayer.querySelector('.fx-sel');
  const selOutline = selSvg.querySelector('path');
  const spotSvg = fxLayer.querySelector('.fx-spot');
  const spotOutline = spotSvg.querySelector('path');
  const homePin = fxLayer.querySelector('.fx-homemark');
  const homeLabel = homePin.querySelector('.home-label');
  homeLabel.textContent = t('home_label');
  const reticle = fxLayer.querySelector('.fx-reticle');
  let homeXY = null;

  let features = [];
  const byIso = new Map();
  const centroidCache = new Map();
  const boundsCache = new Map();
  let countrySel = null;
  let dotSel = null;
  let spotIso = null;
  let selIso = null;

  function buildFeatures(world) {
    const geoms = world.objects.countries.geometries;
    const groups = d3.group(geoms, (g) => String(g.id));
    const out = [];
    for (const [id, list] of groups) {
      let feature;
      if (list.length === 1) {
        feature = topojson.feature(world, list[0]);
      } else {
        feature = { type: 'Feature', id, properties: list[0].properties, geometry: topojson.merge(world, list) };
      }
      feature.id = id;
      state.data.worldNames.set(id, feature.properties?.name || id);
      out.push(feature);
    }
    // Advisory countries without a polygon (small overseas territories) get a marker disc.
    const alerts = state.data.alerts?.countries || {};
    for (const iso of Object.keys(alerts)) {
      if (groups.has(iso)) continue;
      const c = state.data.countries?.[iso];
      if (!c || c.lat == null) continue;
      out.push({
        type: 'Feature', id: iso, marker: true, properties: { name: c.en },
        geometry: d3.geoCircle().center([c.lon, c.lat]).radius(0.9)(),
      });
    }
    // Draw markers last so they sit on top of neighbouring land.
    out.sort((a, b) => (a.marker ? 1 : 0) - (b.marker ? 1 : 0));
    return out;
  }

  function labelFor(d) {
    const lvl = levelOf(d.id);
    const rows = alertsOf(d.id).length;
    const n = rows ? groupAlerts(d.id).length : 0;
    return `${countryName(d.id)} — ${levelShort(lvl)}${n ? ` — ${t('tooltip_advisories', { n, rows })}` : ''}`;
  }

  function classFor(d) {
    const lvl = levelOf(d.id);
    let c = `country lvl-${lvl}`;
    if (d.id === 'TW') c += ' home';
    if (d.marker) c += ' marker';
    if (state.filter.size && !state.filter.has(lvl)) c += ' dim';
    if (state.filter.size && state.filter.has(lvl)) c += ' lit';
    if (d.id === selIso || d.id === spotIso) c += ' focus';
    return c;
  }

  // countries shown in the panel or picked by the spotlight render in their full level colour
  function refreshFocus() {
    if (countrySel) countrySel.classed('focus', (d) => d.id === selIso || d.id === spotIso);
  }

  function fit() {
    // The map is fixed to the full viewport: use the window size (no forced layout read).
    width = Math.max(320, window.innerWidth);
    height = Math.max(240, window.innerHeight);
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    fxSvgs.forEach((s) => s.setAttribute('viewBox', `0 0 ${width} ${height}`));
    const narrow = width < 760;
    const ins = getInsets?.() || null;
    const land = { type: 'FeatureCollection', features: features.filter((f) => f.id !== 'AQ') };
    if (narrow && ins) {
      // Portrait phones: fill the free band between overlays; the map is wider than the screen and pans.
      const top = Math.min(ins.top, height * 0.45);
      const bottom = Math.min(ins.bottom, height * 0.4);
      projection.fitExtent([[-width * 0.7, top], [width * 1.7, Math.max(top + 160, height - bottom)]], land);
      const home = projection([121, 23.7]);
      const [tx, ty] = projection.translate();
      projection.translate([tx + (width * 0.5 - home[0]), ty]); // centre on Taiwan
    } else {
      const top = Math.min(150, height * 0.17);
      projection.fitExtent([[18, top], [width - 18, height - 46]], land);
    }
    centroidCache.clear();
    boundsCache.clear();
  }

  function redraw() {
    sphere.attr('d', path);
    graticule.attr('d', path);
    if (countrySel) countrySel.attr('d', (d) => (d._d = path(d)));
    homeXY = centroid('TW');
    homePin.hidden = !homeXY;
    const tw = byIso.get('TW');
    homeGlow.setAttribute('d', tw ? tw._d || path(tw) : '');
    renderDanger();
    renderDots();
    if (state.selected) setSelected(state.selected);
    if (spotIso) setSpotlight(spotIso);
    updateScaled();
  }

  function render() {
    features = buildFeatures(state.data.world);
    features.forEach((f) => byIso.set(f.id, f));
    fit();
    countrySel = gCountries.selectAll('path.country')
      .data(features, (d) => d.id)
      .join('path')
      .attr('id', (d) => `c-${d.id}`)
      .attr('data-iso', (d) => d.id)
      .attr('class', classFor)
      .attr('role', 'button')
      .attr('tabindex', (d) => (levelOf(d.id) > 0 || d.id === 'TW' ? 0 : -1))
      .attr('aria-label', labelFor)
      .on('pointerenter', (ev, d) => hover(d, ev))
      .on('pointermove', (ev) => moveTip(ev.clientX, ev.clientY))
      .on('pointerleave', () => unhover())
      .on('focus', (ev, d) => {
        const b = ev.target.getBoundingClientRect();
        hover(d, { clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 });
      })
      .on('blur', () => unhover())
      .on('click', (ev, d) => onOpen(d.id))
      .on('keydown', (ev, d) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onOpen(d.id);
        }
      });
    redraw();
  }

  function hover(d, ev) {
    const lvl = levelOf(d.id);
    hoverOutline.attr('d', d._d).attr('class', `outline hover-outline lvl-${lvl}${d.id === 'TW' ? ' home' : ''}`).classed('on', true);
    const rows = alertsOf(d.id).length;
    const n = rows ? groupAlerts(d.id).length : 0;
    const flights = routesTo(d.id);
    const dep = d3.sum(flights, (r) => r.departures);
    const arr = d3.sum(flights, (r) => r.arrivals);
    const home = d.id === 'TW';
    showTip(`
      <div class="tip-head">${badge(lvl)}<span class="tip-iso">${esc(d.id.length === 2 ? d.id : '')}</span></div>
      <div class="tip-name">${esc(countryName(d.id))}</div>
      <div class="tip-alt">${esc(countryAltName(d.id))}</div>
      <div class="tip-row">${home ? esc(t('tooltip_home')) : esc(t('tooltip_advisories', { n, rows }))}</div>
      ${flights.length ? `<div class="tip-row tip-flights">✈ ${esc(t('tooltip_flights', { d: dep, a: arr }))}</div>` : ''}
      ${!home ? `<div class="tip-hint">${esc(t('tooltip_click'))}</div>` : ''}`, ev.clientX, ev.clientY);
    emit('map:hover', d.id);
  }
  function unhover() {
    hoverOutline.classed('on', false);
    hideTip();
    emit('map:hover', null);
  }

  function renderDanger() {
    const l3 = features.filter((f) => levelOf(f.id) === 3);
    const rows = l3.flatMap((f) => [{ f, halo: true }, { f, halo: false }]);
    dangerG.selectAll('path').data(rows).join('path')
      .attr('class', (r) => (r.halo ? 'halo' : null))
      .attr('d', (r) => r.f._d || path(r.f));
  }

  function renderDots() {
    const routes = state.data.flights?.routes || [];
    dotSel = gDots.selectAll('g.dest')
      .data(routes, (r) => r.iata)
      .join((enter) => {
        const g = enter.append('g').attr('class', 'dest');
        g.append('circle').attr('class', 'dest-halo');
        g.append('circle').attr('class', 'dest-dot');
        return g;
      })
      .attr('data-iata', (r) => r.iata)
      .attr('data-x', (r) => projection([r.lon, r.lat])[0])
      .attr('data-y', (r) => projection([r.lon, r.lat])[1])
      .on('pointerenter', (ev, r) => {
        const al = (r.airlines || []).join(' · ');
        const city = state.lang === 'en' ? r.city_en : r.city_zh;
        const alt = state.lang === 'en' ? r.city_zh : r.city_en;
        showTip(`
          <div class="tip-head"><span class="tip-iata">${esc(r.iata)}</span><span class="tip-iso">${esc(r.country || '')}</span></div>
          <div class="tip-name">${esc(city)}</div><div class="tip-alt">${esc(alt)}</div>
          <div class="tip-grid">
            <span>${esc(t('flights_dep'))}</span><b class="out">${fmtNum(r.departures)}</b>
            <span>${esc(t('flights_arr'))}</span><b class="in">${fmtNum(r.arrivals)}</b>
          </div>
          ${al ? `<div class="tip-row">${esc(t('tooltip_airlines'))}: <span class="mono">${esc(al)}</span></div>` : ''}`,
        ev.clientX, ev.clientY);
      })
      .on('pointermove', (ev) => moveTip(ev.clientX, ev.clientY))
      .on('pointerleave', hideTip);
    updateScaled();
  }

  // Keep dots constant on screen regardless of zoom; mirror the zoom onto the fx overlays.
  function updateScaled() {
    const k = transform.k;
    const tr = transform.toString();
    fxGroups.forEach((g) => g.setAttribute('transform', tr));
    if (homeXY) {
      const [x, y] = transform.apply(homeXY);
      homePin.style.transform = `translate(${x}px, ${y}px)`;
    }
    if (spotIso) {
      const c = centroid(spotIso);
      if (c) {
        const [x, y] = transform.apply(c);
        reticle.style.transform = `translate(${x}px, ${y}px)`;
      }
    }
    if (dotSel) {
      dotSel.attr('transform', function () {
        return `translate(${this.getAttribute('data-x')},${this.getAttribute('data-y')}) scale(${1 / k})`;
      });
      dotSel.select('.dest-dot').attr('r', (r) => 1.8 + Math.sqrt(r.departures + r.arrivals) * 0.45);
      dotSel.select('.dest-halo').attr('r', (r) => 5 + Math.sqrt(r.departures + r.arrivals) * 0.9);
    }
  }

  // ---- zoom ----
  const zoom = d3.zoom()
    .scaleExtent([1, 14])
    .on('start', (ev) => { if (!ev.sourceEvent) unhover(); }) // map moves under a still pointer
    .on('zoom', (ev) => {
      transform = ev.transform;
      gZoom.attr('transform', transform);
      svgEl.style.setProperty('--k', transform.k);
      updateScaled();
      zoomListeners.forEach((fn) => fn(transform, ev.sourceEvent));
      if (ev.sourceEvent) emit('map:user', ev.sourceEvent.type);
    });
  svg.call(zoom).on('dblclick.zoom', null).on('dblclick', () => reset());

  function setExtent() {
    const [[sx0, sy0], [sx1, sy1]] = path.bounds({ type: 'Sphere' });
    zoom.extent([[0, 0], [width, height]])
      .translateExtent([
        [Math.min(0, sx0) - width * 0.3, Math.min(0, sy0) - height * 0.3],
        [Math.max(width, sx1) + width * 0.3, Math.max(height, sy1) + height * 0.3],
      ]);
  }

  function dur(ms) { return reducedMotion() ? 0 : ms; }

  function reset(ms = 900) {
    svg.transition().duration(dur(ms)).call(zoom.transform, d3.zoomIdentity);
  }
  function zoomBy(factor) {
    svg.transition().duration(dur(350)).call(zoom.scaleBy, factor);
  }

  function centroid(iso) {
    if (centroidCache.has(iso)) return centroidCache.get(iso);
    const f = byIso.get(iso);
    let c = null;
    if (f) {
      const b = largestBounds(iso);
      const cand = path.centroid(largestPart(f));
      c = Number.isFinite(cand[0]) ? cand : [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
    }
    centroidCache.set(iso, c);
    return c;
  }

  function largestPart(f) {
    const g = f.geometry;
    if (!g || g.type !== 'MultiPolygon') return f;
    let best = null;
    let bestA = -1;
    for (const coords of g.coordinates) {
      const p = { type: 'Polygon', coordinates: coords };
      const a = d3.geoArea(p);
      if (a > bestA) { bestA = a; best = p; }
    }
    return best;
  }

  function largestBounds(iso) {
    if (boundsCache.has(iso)) return boundsCache.get(iso);
    const f = byIso.get(iso);
    const b = f ? path.bounds(largestPart(f)) : null;
    boundsCache.set(iso, b);
    return b;
  }

  /** Smoothly zoom so `iso` fills the free area (pad = space taken by overlays). */
  function flyTo(iso, { pad = {}, maxScale = 5, ms = 1600 } = {}) {
    const b = largestBounds(iso);
    if (!b) return false;
    const [[x0, y0], [x1, y1]] = b;
    const left = pad.left ?? 0;
    const right = pad.right ?? 0;
    const top = pad.top ?? 0;
    const bottom = pad.bottom ?? 0;
    const aw = Math.max(120, width - left - right);
    const ah = Math.max(120, height - top - bottom);
    const k = clamp(0.42 / Math.max((x1 - x0) / aw, (y1 - y0) / ah), 1.3, maxScale);
    const [cx, cy] = centroid(iso) || [(x0 + x1) / 2, (y0 + y1) / 2];
    const tx = left + aw / 2 - k * cx;
    const ty = top + ah / 2 - k * cy;
    svg.interrupt().transition().duration(dur(ms)).ease(d3.easeCubicInOut)
      .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
    return true;
  }

  function setSelected(iso) {
    const f = iso && byIso.get(iso);
    selIso = f ? iso : null;
    refreshFocus();
    selOutline.setAttribute('d', f ? f._d || path(f) : '');
    selSvg.toggleAttribute('hidden', !f); // SVG elements have no .hidden property: toggle the attribute
  }

  // Compositor-only pulse (opacity on an overlay element), restarted without a forced reflow.
  function pulse(el, keyframes, opts) {
    if (reducedMotion() || !el.animate) return;
    el.getAnimations?.().forEach((a) => a.cancel());
    el.animate(keyframes, opts);
  }

  function setSpotlight(iso) {
    spotIso = iso && byIso.has(iso) ? iso : null;
    const f = spotIso && byIso.get(spotIso);
    spotOutline.setAttribute('d', f ? f._d || path(f) : '');
    spotSvg.toggleAttribute('hidden', !f);
    refreshFocus();
    reticle.hidden = !f;
    if (f) {
      pulse(spotSvg, [{ opacity: 0 }, { opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }, { opacity: 0.9 }],
        { duration: 3600, easing: 'ease-out' });
      // the pin itself carries the position transform, so the zoom-in runs on its inner svg
      pulse(reticle.querySelector('.ret-static'), [{ opacity: 0, transform: 'scale(1.6)' }, { opacity: 1, transform: 'scale(1)' }],
        { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    updateScaled();
  }

  function applyFilter() {
    if (countrySel) countrySel.attr('class', classFor);
  }

  function relabel() {
    svg.attr('aria-label', t('map_label'));
    homeLabel.textContent = t('home_label');
    if (countrySel) countrySel.attr('aria-label', labelFor);
  }

  function resize() {
    if (!features.length) return;
    fit();
    setExtent();
    redraw();
    svg.call(zoom.transform, d3.zoomIdentity);
    resizeListeners.forEach((fn) => fn());
  }

  function init() {
    render();
    setExtent();
  }

  return {
    init,
    resize,
    reset,
    zoomBy,
    flyTo,
    setSelected,
    setSpotlight,
    applyFilter,
    relabel,
    renderDots,
    centroid,
    has: (iso) => byIso.has(iso),
    projection,
    size: () => [width, height],
    transform: () => transform,
    onZoom: (fn) => zoomListeners.add(fn),
    onResize: (fn) => resizeListeners.add(fn),
    setDotsVisible: (v) => gDots.style('display', v ? null : 'none'),
  };
}
