// trip.html world map: a light SVG choropleth with two layers (MOFA/MAC warnings, Taiwan CDC notices).
// Fills come from CSS ([data-tab] on the wrapper × data-m / data-c on each path), so switching layers is
// a single attribute change. Hatched overlays mark countries rated higher in some areas than nationwide.
// A third tab ("wx") hands the untransformed overlay group to trip-wxmap.js, which keeps its city markers
// at constant screen size by re-projecting them through the current zoom transform (see onView).
import { h, mofaChip, cdcChip } from './trip-dom.js';
import { t, nameOf, altNameOf, mofaFull, cdcFull } from './trip-i18n.js';

// Pacific-centred like the main radar, so Asia / Taiwan sit left of centre.
const ROTATE = [-155, 0];

export function createMap({ box, svgEl, tipEl, onOpen }) {
  const d3 = window.d3;
  const topojson = window.topojson;
  if (!d3 || !topojson) throw new Error('d3 / topojson-client not loaded');

  const svg = d3.select(svgEl);
  const projection = d3.geoNaturalEarth1().rotate(ROTATE).precision(0.4);
  const path = d3.geoPath(projection);
  let features = [];
  let byIso = new Map();
  let model = null;
  let width = 0;
  let height = 0;
  let selIso = null;
  let boxRect = null;
  let cur = d3.zoomIdentity;

  const defs = svg.append('defs');
  for (const lv of [1, 2, 3, 4]) {
    const p = defs.append('pattern').attr('id', `trip-hatch-${lv}`).attr('patternUnits', 'userSpaceOnUse')
      .attr('width', 5).attr('height', 5).attr('patternTransform', 'rotate(45)');
    p.append('rect').attr('class', `hatch-line m-${lv}`).attr('width', 2.2).attr('height', 5);
  }
  const gZoom = svg.append('g').attr('class', 'zl');
  const sphere = gZoom.append('path').attr('class', 'sphere').datum({ type: 'Sphere' });
  const gC = gZoom.append('g').attr('class', 'cts');
  const gH = gZoom.append('g').attr('class', 'hatches').attr('aria-hidden', 'true');
  const selPath = gZoom.append('path').attr('class', 'sel-outline').attr('aria-hidden', 'true');
  // not zoom-transformed: overlay content is positioned in screen units by its owner
  const gOver = svg.append('g').attr('class', 'overlay');
  const viewListeners = new Set();
  let viewFrame = 0;
  function notifyView() {
    if (viewFrame) return;
    viewFrame = requestAnimationFrame(() => { viewFrame = 0; for (const fn of viewListeners) fn(); });
  }
  let countrySel = null;
  let hatchSel = null;

  // ---- zoom: mouse drag / ctrl+wheel / pinch; one-finger touch scrolls the page unless zoomed in ----
  const zoom = d3.zoom()
    .scaleExtent([1, 10])
    .filter((ev) => {
      if (ev.type === 'wheel') return ev.ctrlKey || ev.metaKey;
      if (ev.type.startsWith('touch')) return (ev.touches?.length || 0) > 1 || cur.k > 1;
      return !ev.button && !ev.ctrlKey;
    })
    .on('zoom', (ev) => {
      cur = ev.transform;
      gZoom.attr('transform', cur);
      box.classList.toggle('zoomed', cur.k > 1.01);
      notifyView();
    });
  svg.call(zoom).on('dblclick.zoom', null);

  function buildFeatures(world) {
    const geoms = world?.objects?.countries?.geometries || [];
    const groups = d3.group(geoms, (g) => String(g.id));
    const out = [];
    for (const [id, list] of groups) {
      if (id === 'AQ') continue;
      const f = list.length === 1
        ? topojson.feature(world, list[0])
        : { type: 'Feature', properties: list[0].properties, geometry: topojson.merge(world, list) };
      f.id = id;
      out.push(f);
    }
    // listed destinations without a polygon (small islands) get a marker disc
    for (const d of model?.list || []) {
      if (groups.has(d.iso)) continue;
      const lat = Number(d.c?.lat);
      const lon = Number(d.c?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.push({ type: 'Feature', id: d.iso, marker: true, properties: {}, geometry: d3.geoCircle().center([lon, lat]).radius(0.8)() });
    }
    out.sort((a, b) => (a.marker ? 1 : 0) - (b.marker ? 1 : 0));
    return out;
  }

  function fit() {
    width = Math.max(280, Math.round(box.clientWidth));
    const land = { type: 'FeatureCollection', features: features.filter((f) => !f.marker) };
    projection.scale(1).translate([0, 0]);
    projection.fitWidth(width - 8, land);
    const b = path.bounds(land);
    const [tx, ty] = projection.translate();
    projection.translate([tx + 4, ty - b[0][1] + 6]);
    height = Math.ceil(b[1][1] - b[0][1] + 12);
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    zoom.extent([[0, 0], [width, height]]).translateExtent([[0, 0], [width, height]]);
  }

  function draw() {
    sphere.attr('d', path);
    countrySel.attr('d', (d) => (d._d = path(d)));
    hatchSel?.attr('d', (d) => byIso.get(d.iso)?._d || '');
    selPath.attr('d', selIso ? byIso.get(selIso)?._d || '' : '');
  }

  function render(world, m) {
    model = m;
    features = buildFeatures(world);
    byIso = new Map(features.map((f) => [f.id, f]));
    fit();
    countrySel = gC.selectAll('path.ct')
      .data(features, (d) => d.id)
      .join('path')
      .attr('class', (d) => `ct${d.marker ? ' mk' : ''}${d.id === 'TW' ? ' tw' : ''}${model.dests.has(d.id) ? ' has' : ''}`)
      .attr('data-iso', (d) => d.id);
    paint();
    draw();
    svg.call(zoom.transform, d3.zoomIdentity);
    box.classList.add('ready');

    let lastW = width;
    const ro = new ResizeObserver(() => {
      const w = Math.round(box.clientWidth);
      if (Math.abs(w - lastW) < 2) return;
      lastW = w;
      fit();
      draw();
      svg.call(zoom.transform, d3.zoomIdentity);
    });
    ro.observe(box);
  }

  /** Level attributes per path; called after (re)loading data. */
  function paint() {
    if (!countrySel) return;
    countrySel
      .attr('data-m', (d) => {
        const x = model.dests.get(d.id);
        return x?.w ? (x.mofa ?? 0) : 'n';
      })
      .attr('data-c', (d) => {
        const x = model.dests.get(d.id);
        return x?.a ? x.cdc : 'n';
      });
    const partial = model.list.filter((x) => x.partial && byIso.has(x.iso));
    hatchSel = gH.selectAll('path')
      .data(partial, (d) => d.iso)
      .join('path')
      .attr('class', (d) => `hatch m-${d.mofaMax}`)
      .attr('fill', (d) => `url(#trip-hatch-${d.mofaMax})`)
      .attr('d', (d) => byIso.get(d.iso)?._d || '');
  }

  // ---- tooltip (built with textContent only) ----
  function tipFor(iso) {
    tipEl.replaceChildren();
    if (iso === 'TW') {
      tipEl.append(h('strong', { text: t('tip_tw') }));
      return true;
    }
    const d = model.dests.get(iso);
    if (!d) return false;
    tipEl.append(...[
      h('strong', { class: 'tip-name', text: nameOf(d) }),
      h('span', { class: 'tip-alt', text: altNameOf(d) }),
      h('span', { class: 'tip-row' },
        h('span', { class: 'tip-k', text: d.source === 'mac' ? t('tip_mac') : t('tip_mofa') }),
        d.w
          ? mofaChip(d.mofa, { size: 'sm', text: d.mofa == null ? t('mofa_regional_only') : mofaFull(d.mofa, d.source) })
          : mofaChip(null, { size: 'sm' })),
      d.partial ? h('span', { class: 'tip-row tip-sub' }, h('span', { class: 'tip-k' }),
        mofaChip(d.mofaMax, { size: 'sm', text: t('partial_level', { n: d.mofaMax }) })) : null,
      h('span', { class: 'tip-row' },
        h('span', { class: 'tip-k', text: t('tip_cdc') }),
        cdcChip(d.cdc, { size: 'sm', text: cdcFull(d.cdc) })),
      h('span', { class: 'tip-hint', text: t('tip_click') }),
    ].filter(Boolean));
    return true;
  }
  function placeTip(ev) {
    if (!boxRect) return;
    const x = ev.clientX - boxRect.left;
    const y = ev.clientY - boxRect.top;
    const tw = tipEl.offsetWidth;
    const left = x + 14 + tw > boxRect.width ? Math.max(4, x - 14 - tw) : x + 14;
    tipEl.style.transform = `translate(${Math.round(left)}px, ${Math.round(y + 14)}px)`;
  }
  const isoOf = (ev) => ev.target?.closest?.('path.ct')?.dataset.iso || null;
  gC.on('pointerover', (ev) => {
    const iso = isoOf(ev);
    // weather tab: the city markers own the tooltip
    if (!iso || ev.pointerType === 'touch' || box.dataset.tab === 'wx' || !tipFor(iso)) { tipEl.hidden = true; return; }
    boxRect = box.getBoundingClientRect();
    tipEl.hidden = false;
    placeTip(ev);
  });
  gC.on('pointermove', (ev) => { if (!tipEl.hidden) placeTip(ev); });
  gC.on('pointerout', (ev) => {
    if (!ev.relatedTarget || !gC.node().contains(ev.relatedTarget)) tipEl.hidden = true;
  });
  gC.on('click', (ev) => {
    const iso = isoOf(ev);
    if (iso && iso !== 'TW' && model?.dests.has(iso)) { tipEl.hidden = true; onOpen(iso); }
  });

  return {
    render,
    paint,
    select(iso) {
      selIso = iso;
      selPath.attr('d', iso ? byIso.get(iso)?._d || '' : '');
    },
    zoomBy(k) { svg.transition().duration(250).call(zoom.scaleBy, k); },
    reset() { svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity); },
    hideTip() { tipEl.hidden = true; },
    hasShape: (iso) => byIso.has(iso),
    // ---- overlay API (trip-wxmap.js) ----
    overlay: gOver.node(),
    /** [x, y] in viewBox units at the current zoom, or null. */
    project(lon, lat) {
      const p = projection([lon, lat]);
      return p ? cur.apply(p) : null;
    },
    size: () => ({ width, height }),
    /** Called (once per frame) after zoom, pan or a resize. */
    onView(fn) { viewListeners.add(fn); return () => viewListeners.delete(fn); },
  };
}
