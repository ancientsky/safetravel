// Outbreak route watch: the direct-flight network of an outbreak city (e.g. Irkutsk, suspected plague) drawn on
// the map on demand. Data: data/watch.json (pipeline/watch.py). Header button → menu card with one switch per set.
import { state, emit } from './state.js';
import { t, isEn, countryName, fmtNum } from './i18n.js';
import { showTip, moveTip, hideTip } from './tooltip.js';
import { esc, storageGet, storageSet } from './util.js';

const d3 = window.d3;
const KEY = 'safetravel.watch';
const LABEL_TOP = 6; // always label the busiest destinations (plus every one with a direct TPE link)

function readOn() {
  const q = new URLSearchParams(location.search).get('watch');
  if (q != null) return new Set(q.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  try { return new Set(JSON.parse(storageGet(KEY) || '[]')); } catch { return new Set(); }
}

export function createWatch({ button, menu, map }) {
  let sets = [];
  let status = 'idle'; // idle | loading | ready | error
  const on = readOn();
  const fromUrl = new URLSearchParams(location.search).has('watch');

  // ---------------------------------------------------------------- data
  async function load() {
    if (status === 'ready' || status === 'loading') return;
    status = 'loading';
    try {
      const res = await fetch('data/watch.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      sets = Array.isArray(d?.sets) ? d.sets : [];
      status = 'ready';
    } catch {
      status = 'error';
    }
    renderMenu();
    layer.update();
  }
  const active = () => sets.filter((s) => on.has(s.id));
  const tpeLinked = () => new Set((state.data.flights?.routes || []).map((r) => r.iata));
  const city = (r) => (isEn() ? r.city_en : r.city_zh) || r.iata;
  const hubName = (s) => (isEn() ? s.hub_en : s.hub_zh) || s.hub.iata;

  // ---------------------------------------------------------------- menu card
  function setDetails(s) {
    const linked = tpeLinked();
    const viaTpe = s.routes.filter((r) => linked.has(r.iata));
    const byCountry = new Map();
    for (const r of s.routes) byCountry.set(r.country, (byCountry.get(r.country) || 0) + r.monthly);
    const countries = [...byCountry.entries()].sort((a, b) => b[1] - a[1]);
    const top = s.routes.slice(0, 5);
    return `<div class="wt-detail">
      <dl class="wt-stats">
        <div><dt>${esc(t('watch_dest'))}</dt><dd class="mono">${fmtNum(s.totals.destinations)}</dd></div>
        <div><dt>${esc(t('watch_monthly'))}</dt><dd class="mono">${fmtNum(s.totals.monthly)}</dd></div>
        <div><dt>${esc(t('watch_countries'))}</dt><dd class="mono">${fmtNum(s.totals.countries)}</dd></div>
      </dl>
      <p class="wt-label">${esc(t('watch_by_country'))}</p>
      <ul class="wt-chips">${countries.map(([c, n]) => `<li><span>${esc(c ? countryName(c) : '—')}</span><b class="mono">${fmtNum(n)}</b></li>`).join('')}</ul>
      ${viaTpe.length ? `<p class="wt-label wt-tpe">${esc(t('watch_tpe_link'))}</p>
      <ul class="wt-chips wt-chips-tpe">${viaTpe.map((r) => `<li><span>${esc(city(r))}</span><b class="mono">${esc(r.iata)}</b></li>`).join('')}</ul>` : ''}
      <p class="wt-label">${esc(t('watch_top'))}</p>
      <ol class="wt-top">${top.map((r) => `<li><span>${esc(city(r))} <i class="mono">${esc(r.iata)}</i></span><b class="mono">${esc(t('watch_per_month', { n: fmtNum(r.monthly) }))}</b></li>`).join('')}</ol>
      <div class="wt-foot">
        <button type="button" class="wt-fit" data-fit="${esc(s.id)}">${esc(t('watch_fit'))}</button>
        <span class="wt-src">${esc(isEn() ? s.source_en : s.source_zh)} · ${esc(s.as_of)}</span>
      </div>
    </div>`;
  }

  function renderMenu() {
    if (menu.hidden) return;
    const body = menu.querySelector('.wt-body');
    if (status !== 'ready') {
      body.innerHTML = `<p class="wt-empty">${esc(status === 'error' ? t('watch_error') : t('watch_loading'))}</p>`;
      return;
    }
    if (!sets.length) { body.innerHTML = `<p class="wt-empty">${esc(t('watch_none'))}</p>`; return; }
    body.innerHTML = sets.map((s) => {
      const isOn = on.has(s.id);
      return `<section class="wt-set${isOn ? ' is-on' : ''}">
        <div class="wt-row">
          <button type="button" class="switch wt-switch" role="switch" aria-checked="${isOn}" data-set="${esc(s.id)}" aria-labelledby="wt-name-${esc(s.id)}"><i aria-hidden="true"></i></button>
          <label id="wt-name-${esc(s.id)}" class="wt-name" data-set="${esc(s.id)}">
            <b>${esc(hubName(s))} <span class="mono">${esc(s.hub.iata)}</span></b>
            <span class="wt-reason">${esc(isEn() ? s.reason_en : s.reason_zh)}</span>
          </label>
        </div>
        ${isOn ? setDetails(s) : `<p class="wt-hint">${esc(t('watch_hint', { n: s.totals.destinations, m: fmtNum(s.totals.monthly) }))}</p>`}
      </section>`;
    }).join('');
  }

  function placeMenu() {
    const b = button.getBoundingClientRect();
    const w = Math.min(380, window.innerWidth - 16);
    menu.style.width = `${w}px`;
    menu.style.top = `${Math.round(b.bottom + 8)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, b.right - w)))}px`;
  }
  function openMenu(v) {
    menu.hidden = !v;
    button.setAttribute('aria-expanded', String(v));
    if (v) { placeMenu(); load(); renderMenu(); }
  }

  // ---------------------------------------------------------------- toggling
  function apply({ fit = false } = {}) {
    storageSet(KEY, JSON.stringify([...on]));
    const any = on.size > 0 && active().length > 0;
    button.classList.toggle('is-active', on.size > 0);
    document.body.classList.toggle('watch-on', any);
    state.mapPinned = any; // the spotlight tour stops moving the map while a watch layer is shown
    layer.update();
    renderMenu();
    if (fit && any) fitTo(active());
    emit('watch:change', [...on]);
  }
  function toggle(id) {
    if (on.has(id)) on.delete(id); else on.add(id);
    apply({ fit: on.has(id) });
  }
  function fitTo(list) {
    const pts = list.flatMap((s) => [[s.hub.lon, s.hub.lat], ...s.routes.map((r) => [r.lon, r.lat])]);
    const narrow = window.innerWidth < 760;
    const right = !menu.hidden && !narrow ? menu.getBoundingClientRect().width + 32 : 40;
    map.fitPoints(pts, { pad: narrow ? { top: 150, bottom: 240, left: 10, right: 10 } : { top: 160, left: 40, right, bottom: 70 } });
  }

  // ---------------------------------------------------------------- map layer
  const layer = (() => {
    const wrap = document.createElement('div');
    wrap.className = 'watch-layer';
    wrap.hidden = true;
    wrap.innerHTML = '<svg class="watch-svg"><g class="zt"><g class="wt-arcs"></g><g class="wt-dots"></g><g class="wt-hubs"></g></g></svg>';
    document.querySelector('#map')?.append(wrap);
    const svg = wrap.querySelector('svg');
    const zt = svg.querySelector('.zt');
    const gArcs = d3.select(svg.querySelector('.wt-arcs'));
    const gDots = d3.select(svg.querySelector('.wt-dots'));
    const gHubs = d3.select(svg.querySelector('.wt-hubs'));

    function arcPath(a, b) {
      const interp = d3.geoInterpolate(a, b);
      const [w] = map.size();
      let d = '';
      let prev = null;
      for (let i = 0; i < 40; i++) {
        const p = map.projection(interp(i / 39));
        d += `${!prev || Math.abs(p[0] - prev[0]) > w * 0.4 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
        prev = p;
      }
      return d;
    }

    function update() {
      const list = active();
      wrap.hidden = !list.length || !map.size()[0];
      if (wrap.hidden) return;
      const [w, h] = map.size();
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      const linked = tpeLinked();
      const rows = list.flatMap((s) => s.routes.map((r) => ({ s, r, key: `${s.id}|${r.iata}`, tpe: linked.has(r.iata) })));
      const width = (m) => 0.8 + Math.sqrt(m) / 4;
      gArcs.selectAll('path').data(rows, (d) => d.key).join('path')
        .attr('class', (d) => `wt-arc${d.tpe ? ' is-tpe' : ''}`)
        .attr('d', (d) => arcPath([d.s.hub.lon, d.s.hub.lat], [d.r.lon, d.r.lat]))
        .style('stroke-width', (d) => width(d.r.monthly));
      const labelled = new Set(list.flatMap((s) => s.routes.slice(0, LABEL_TOP).map((r) => `${s.id}|${r.iata}`)));
      gDots.selectAll('g.wt-dest').data(rows, (d) => d.key).join((en) => {
        const g = en.append('g').attr('class', 'wt-dest');
        g.append('circle').attr('class', 'wt-tpe-ring');
        g.append('circle').attr('class', 'wt-dot');
        g.append('text').attr('class', 'wt-label');
        return g;
      })
        .classed('is-tpe', (d) => d.tpe)
        .each(function (d) {
          const [x, y] = map.projection([d.r.lon, d.r.lat]);
          this.dataset.x = x;
          this.dataset.y = y;
          const rad = 2 + Math.sqrt(d.r.monthly) * 0.45;
          this.querySelector('.wt-dot').setAttribute('r', rad);
          this.querySelector('.wt-tpe-ring').setAttribute('r', rad + 4);
          const label = this.querySelector('.wt-label');
          label.textContent = labelled.has(d.key) || d.tpe ? d.r.iata : '';
          label.setAttribute('x', rad + 3);
          label.setAttribute('y', 3.5);
        })
        .on('pointerenter', (ev, d) => {
          const tpe = d.tpe ? `<div class="tip-row wt-tip-tpe">${esc(t('watch_tip_tpe'))}</div>` : '';
          showTip(`<div class="tip-head"><span class="tip-iata">${esc(d.r.iata)}</span><span class="tip-iso">${esc(d.r.country)}</span></div>
            <div class="tip-name">${esc(city(d.r))}</div><div class="tip-alt">${esc(isEn() ? d.r.city_zh : d.r.city_en)} · ${esc(countryName(d.r.country))}</div>
            <div class="tip-grid"><span>${esc(t('watch_tip_flights', { hub: d.s.hub.iata }))}</span><b class="wt-tip-n">${esc(fmtNum(d.r.monthly))}</b></div>${tpe}`,
          ev.clientX, ev.clientY);
        })
        .on('pointermove', (ev) => moveTip(ev.clientX, ev.clientY))
        .on('pointerleave', hideTip);
      gHubs.selectAll('g.wt-hub').data(list, (s) => s.id).join((en) => {
        const g = en.append('g').attr('class', 'wt-hub');
        g.append('circle').attr('class', 'wt-hub-ring').attr('r', 16);
        g.append('circle').attr('class', 'wt-hub-ring wt-hub-ring2').attr('r', 16);
        g.append('circle').attr('class', 'wt-hub-dot').attr('r', 5);
        g.append('text').attr('class', 'wt-hub-label').attr('x', 12).attr('y', -10);
        g.append('text').attr('class', 'wt-hub-sub').attr('x', 12).attr('y', 5);
        return g;
      }).each(function (s) {
        const [x, y] = map.projection([s.hub.lon, s.hub.lat]);
        this.dataset.x = x;
        this.dataset.y = y;
        this.querySelector('.wt-hub-label').textContent = `${hubName(s)} ${s.hub.iata}`;
        this.querySelector('.wt-hub-sub').textContent = isEn() ? s.reason_en : s.reason_zh;
      });
      scale();
    }

    function scale() {
      if (wrap.hidden) return;
      const tr = map.transform();
      zt.setAttribute('transform', tr.toString());
      const s = `scale(${1 / tr.k})`;
      gDots.selectAll('g.wt-dest').attr('transform', function () { return `translate(${this.dataset.x},${this.dataset.y}) ${s}`; });
      gHubs.selectAll('g.wt-hub').attr('transform', function () { return `translate(${this.dataset.x},${this.dataset.y}) ${s}`; });
    }

    map.onZoom(scale);
    map.onResize(update);
    return { update };
  })();

  // ---------------------------------------------------------------- events
  button.addEventListener('click', () => openMenu(menu.hidden));
  menu.querySelector('.wt-close').addEventListener('click', () => { openMenu(false); button.focus(); });
  menu.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-set]');
    if (sw) { toggle(sw.dataset.set); return; }
    const fit = e.target.closest('[data-fit]');
    if (fit) fitTo(sets.filter((s) => s.id === fit.dataset.fit));
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { openMenu(false); button.focus(); } });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) openMenu(false);
  });
  window.addEventListener('resize', () => { if (!menu.hidden) placeMenu(); });

  async function init() {
    button.setAttribute('aria-expanded', 'false');
    if (!on.size) return;
    await load();
    if (fromUrl) storageSet(KEY, JSON.stringify([...on]));
    apply({ fit: true });
  }

  return {
    init,
    refresh: () => { renderMenu(); layer.update(); },
    debug: { sets: () => sets, on: () => [...on], toggle },
  };
}
