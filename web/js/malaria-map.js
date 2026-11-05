// malaria.html — 瘧疾感染風險地圖: two layers on one SVG world map.
//   cdc: Taiwan CDC's advice per destination (data/malaria.json countries[].risk)
//   who: WHO World Malaria Report 2025 map of malaria status in 2024 (data/malaria.json "who"; digitised from the image
//        attached to CDC's 瘧疾預防用藥 page — see data/manual/who_malaria_2024.json)
// Fills come from CSS ([data-layer] on the box × data-r / data-w on each path). Clicking a country with a CDC entry
// adds it to the itinerary. Everything is built with textContent.

const WHO_CATS = ['endemic', 'certified', 'zero3y', 'none', 'na'];
const CDC_CATS = ['drug', 'unknown', 'bites', 'none'];

export function createMalariaMap({ box, svgEl, tipEl, legendEl, data, t, isEn, onPick }) {
  const d3 = window.d3;
  const topojson = window.topojson;
  if (!d3 || !topojson) throw new Error('d3 / topojson-client not loaded');
  const countries = data?.countries || {};
  const who = data?.who || null;
  const whoOf = new Map();
  for (const [k, list] of Object.entries(who?.categories || {})) for (const iso of list) whoOf.set(iso, k);
  const excluded = new Set(who?.exclude || []);

  const svg = d3.select(svgEl);
  const projection = d3.geoNaturalEarth1().rotate([-12, 0]).precision(0.4);
  const path = d3.geoPath(projection);
  const gZoom = svg.append('g');
  const gC = gZoom.append('g').attr('class', 'mm-cts');
  let features = [];
  let sel = null;
  let cur = d3.zoomIdentity;
  let trip = new Set();
  let width = 0;
  let height = 0;

  const zoom = d3.zoom()
    .scaleExtent([1, 12])
    .filter((ev) => {
      if (ev.type === 'wheel') return ev.ctrlKey || ev.metaKey;
      if (ev.type.startsWith('touch')) return (ev.touches?.length || 0) > 1 || cur.k > 1;
      return !ev.button && !ev.ctrlKey;
    })
    .on('zoom', (ev) => {
      cur = ev.transform;
      gZoom.attr('transform', cur);
      gC.selectAll('path').attr('stroke-width', 0.5 / cur.k);
      box.classList.toggle('zoomed', cur.k > 1.01);
    });
  svg.call(zoom).on('dblclick.zoom', null);

  const whoCat = (iso) => (excluded.has(iso) ? 'excl' : whoOf.get(iso) || 'none');
  const cdcCat = (iso) => (iso === 'TW' ? 'tw' : countries[iso]?.risk || 'nodata');
  const nameOf = (f) => {
    const c = countries[f.id];
    if (c) return isEn() ? c.en || c.zh : c.zh;
    return f.properties?.name || f.id;
  };

  function render(world) {
    const obj = world.objects.countries || Object.values(world.objects)[0];
    features = topojson.feature(world, obj).features.filter((f) => f.id !== 'AQ');
    size();
    sel = gC.selectAll('path').data(features, (f) => f.id).join('path')
      .attr('d', path)
      .attr('data-iso', (f) => f.id)
      .attr('data-r', (f) => cdcCat(f.id))
      .attr('data-w', (f) => whoCat(f.id))
      .attr('stroke-width', 0.5);
    mark([...trip]);
    renderLegend();
  }

  function size() {
    width = Math.max(300, box.clientWidth || 800);
    height = Math.round(width * 0.5);
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    projection.fitExtent([[4, 4], [width - 4, height - 4]], { type: 'FeatureCollection', features });
    zoom.extent([[0, 0], [width, height]]).translateExtent([[0, 0], [width, height]]);
    sel?.attr('d', path);
  }

  function layer() { return box.dataset.layer === 'who' ? 'who' : 'cdc'; }

  function renderLegend() {
    const L = layer();
    const count = (fn) => features.filter(fn).length;
    const item = (cls, label, n) => {
      const li = document.createElement('li');
      const sw = document.createElement('i');
      sw.className = `mm-sw ${cls}`;
      sw.setAttribute('aria-hidden', 'true');
      const s = document.createElement('span');
      s.textContent = label;
      li.append(sw, s);
      if (n != null) {
        const c = document.createElement('span');
        c.className = 'mm-n';
        c.textContent = String(n);
        li.append(c);
      }
      return li;
    };
    const items = [];
    if (L === 'cdc') {
      for (const k of CDC_CATS) {
        const n = count((f) => cdcCat(f.id) === k);
        if (n || k !== 'unknown') items.push(item(`r-${k}`, t(`risk_${k}`), n));
      }
      items.push(item('r-nodata', t('lg_nodata'), null));
    } else {
      for (const k of WHO_CATS) items.push(item(`w-${k}`, t(`who_${k}`), k === 'none' ? null : count((f) => whoCat(f.id) === k)));
    }
    items.push(item('r-tw', t('lg_tw'), null));
    legendEl.replaceChildren(...items);
  }

  // ---- tooltip ----
  function tipFor(f) {
    const iso = f.id;
    tipEl.replaceChildren();
    const row = (k, v, cls) => {
      const p = document.createElement('span');
      p.className = 'mm-tip-row';
      const a = document.createElement('span');
      a.className = 'mm-tip-k';
      a.textContent = k;
      const b = document.createElement('span');
      b.className = cls || '';
      b.textContent = v;
      p.append(a, b);
      return p;
    };
    const name = document.createElement('strong');
    name.textContent = iso === 'TW' ? t('lg_tw') : nameOf(f);
    tipEl.append(name);
    if (iso === 'TW') return true;
    tipEl.append(row(t('tip_cdc'), t(countries[iso] ? `risk_${countries[iso].risk}` : 'lg_nodata'), `mm-tv r-${cdcCat(iso)}`));
    tipEl.append(row(t('tip_who'), t(whoCat(iso) === 'excl' ? 'who_excl' : `who_${whoCat(iso)}`), `mm-tv w-${whoCat(iso)}`));
    const note = who?.notes?.[iso];
    if (note && isEn()) tipEl.append(row('', note, 'mm-tip-note'));
    const hint = document.createElement('span');
    hint.className = 'mm-tip-hint';
    hint.textContent = countries[iso] ? (trip.has(iso) ? t('tip_in_trip') : t('tip_click')) : t('tip_nodata');
    tipEl.append(hint);
    return true;
  }
  function placeTip(ev) {
    const r = box.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    const tw = tipEl.offsetWidth;
    const left = Math.min(Math.max(8, x + 14), r.width - tw - 8);
    tipEl.style.transform = `translate(${Math.round(left)}px, ${Math.round(y + 16)}px)`;
  }
  gC.on('pointerover', (ev) => {
    const f = ev.target.__data__;
    if (!f || ev.pointerType === 'touch') { tipEl.hidden = true; return; }
    tipFor(f);
    tipEl.hidden = false;
    placeTip(ev);
  });
  gC.on('pointermove', (ev) => { if (!tipEl.hidden) placeTip(ev); });
  gC.on('pointerout', (ev) => { if (!ev.relatedTarget || !gC.node().contains(ev.relatedTarget)) tipEl.hidden = true; });
  gC.on('click', (ev) => {
    const f = ev.target.__data__;
    if (!f || f.id === 'TW' || !countries[f.id]) return;
    tipEl.hidden = true;
    onPick(f.id);
  });

  function mark(isos) {
    trip = new Set(isos.filter(Boolean));
    sel?.classed('is-trip', (f) => trip.has(f.id));
    sel?.filter((f) => trip.has(f.id)).raise();
  }

  let rz = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(rz);
    rz = requestAnimationFrame(() => { size(); svg.call(zoom.transform, d3.zoomIdentity); });
  });

  return {
    render,
    mark,
    setLayer(l) { box.dataset.layer = l === 'who' ? 'who' : 'cdc'; renderLegend(); },
    relabel() { renderLegend(); },
    zoomBy(k) { svg.transition().duration(250).call(zoom.scaleBy, k); },
    reset() { svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity); },
    whoCat,
  };
}
