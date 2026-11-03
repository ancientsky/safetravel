// slide.html: poster templates. Each renderer turns one manifest entry (web/slides/slides.json) into a <section>
// sized to the canvas (1080x1920 portrait / 1920x1080 landscape; layout per orientation lives in slide.css).
// Manifest text is only ever set with textContent: highlights are segment arrays [{t, hl}], never HTML.

const SVG_NS = 'http://www.w3.org/2000/svg';
export const TEMPLATES = ['alert', 'symptoms', 'report', 'germs', 'image'];
export const ASSET_RE = /^slides\/assets\/[A-Za-z0-9._-]+\.(png|webp|jpe?g|svg|gif|avif)$/;

/** h('div', {class, text, dataset, style: {'--d': '.2s'}, ...attrs}, ...children) — text only, never HTML. */
export function h(tag, props, ...kids) {
  return build(document.createElement(tag), props, kids);
}
/** Same for SVG elements. */
export function s(tag, props, ...kids) {
  return build(document.createElementNS(SVG_NS, tag), props, kids);
}
function build(el, props, kids) {
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') for (const [p, x] of Object.entries(v)) el.style.setProperty(p, x); // CSSOM: CSP-safe
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false || kid === '') continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

/** Only https links on cdc.gov.tw (or a subdomain) may come from the manifest. */
export function cdcHref(u) {
  try {
    const x = new URL(String(u));
    const host = x.hostname.toLowerCase();
    if (x.protocol === 'https:' && !x.username && !x.password && (host === 'cdc.gov.tw' || host.endsWith('.cdc.gov.tw'))) return x.href;
  } catch { /* not a URL */ }
  return '';
}
export const assetSrc = (p) => (typeof p === 'string' && ASSET_RE.test(p) && !p.includes('..') ? p : '');

const LANG_ATTR = { zh: 'zh-Hant', en: 'en', bi: 'zh-Hant' };
const delay = (sec) => ({ '--d': `${sec}s` });

/** Text field: plain string (\n = line break) or segment array [{t, hl}] -> nodes. Highlights get a stagger index. */
function rich(v, hlStart = 0) {
  const out = [];
  let hi = hlStart;
  const lines = (txt) => String(txt).split('\n').flatMap((part, i) => (i ? [h('br'), part] : [part]));
  if (typeof v === 'string') return lines(v);
  if (!Array.isArray(v)) return out;
  for (const seg of v) {
    if (!seg || typeof seg.t !== 'string') continue;
    if (seg.hl) out.push(h('mark', { class: 'hl', style: { '--hi': String(hi++) } }, lines(seg.t)));
    else out.push(...lines(seg.t));
  }
  return out;
}
const plain = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => x?.t || '').join('') : '');
const pick = (v, k) => (v && typeof v === 'object' && !Array.isArray(v) ? v[k] : v);

// ---------------------------------------------------------------- brand bar (every slide)
// Identical on every slide whatever its language, so the bar never shifts while the carousel plays.
function brandBar(brand) {
  const b = brand || {};
  const logo = assetSrc(b.logo);
  const url = cdcHref(b.url);
  return h('footer', { class: 'brand' },
    h('div', { class: 'brand-org' },
      logo ? h('span', { class: 'brand-seal' }, h('img', { src: logo, alt: '', width: 512, height: 512, decoding: 'async' })) : null,
      h('span', { class: 'brand-names' },
        h('b', { class: 'brand-zh', lang: 'zh-Hant', text: b.org_zh || '' }),
        h('span', { class: 'brand-en', lang: 'en', text: b.org_en || '' }),
        url ? h('a', { class: 'brand-url', href: url, target: '_blank', rel: 'noopener noreferrer', lang: 'en', text: url.replace(/^https:\/\/|\/$/g, '') }) : null)),
    h('div', { class: 'brand-line' },
      h('span', { class: 'brand-hl' },
        h('span', { class: 'brand-hl-zh', lang: 'zh-Hant', text: b.hotline_zh || '' }),
        h('span', { class: 'brand-hl-en', lang: 'en', text: b.hotline_en || '' })),
      h('span', { class: 'brand-tel' }, phoneIcon(), h('b', { lang: 'en', text: b.hotline || '' }))));
}
function phoneIcon() {
  return s('svg', { class: 'ico-tel', viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    s('path', { d: 'M6.6 2.8 9.4 2.4l1.9 4.6-2.2 1.6a12 12 0 0 0 6.3 6.3l1.6-2.2 4.6 1.9-.4 2.8a2.6 2.6 0 0 1-2.6 2.2A17.4 17.4 0 0 1 2.4 5.4a2.6 2.6 0 0 1 2.2-2.6z' }));
}

// ---------------------------------------------------------------- shared art
function burst(points = 14) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (Math.PI * i) / points - Math.PI / 2;
    const r = i % 2 ? 0.62 + 0.1 * ((i * 7) % 3) / 2 : 1;
    pts.push(`${(100 + 100 * r * Math.cos(a)).toFixed(1)},${(100 + 100 * r * Math.sin(a)).toFixed(1)}`);
  }
  return s('svg', { class: 'burst-shape', viewBox: '-4 -4 208 208', 'aria-hidden': 'true' },
    s('polygon', { class: 'burst-front', points: pts.join(' ') }));
}

/** Cartoon germ (used by germs + report art). */
function germ(cls, x, y, r, d = 0) {
  const bumps = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    bumps.push(s('circle', { cx: (Math.cos(a) * r * 1.02).toFixed(1), cy: (Math.sin(a) * r * 1.02).toFixed(1), r: (r * 0.24).toFixed(1) }));
  }
  return s('g', { class: `germ ${cls}`, transform: `translate(${x} ${y})`, style: delay(d) },
    s('g', { class: 'germ-in' },
      s('g', { class: 'germ-bumps' }, bumps),
      s('circle', { class: 'germ-body', r }),
      s('circle', { class: 'germ-eye', cx: -r * 0.32, cy: -r * 0.12, r: r * 0.24 }),
      s('circle', { class: 'germ-eye', cx: r * 0.32, cy: -r * 0.12, r: r * 0.24 }),
      s('circle', { class: 'germ-pupil', cx: -r * 0.26, cy: -r * 0.08, r: r * 0.11 }),
      s('circle', { class: 'germ-pupil', cx: r * 0.38, cy: -r * 0.08, r: r * 0.11 }),
      s('path', { class: 'germ-mouth', d: `M${-r * 0.3} ${r * 0.34} q${r * 0.3} ${r * 0.26} ${r * 0.6} 0` })));
}

/** Small symptom pictograms for the report template ("icon": fever | cough | breath | unwell). */
const REPORT_ICONS = {
  fever: () => [
    s('rect', { class: 'i-line', x: 26, y: 6, width: 14, height: 38, rx: 7 }),
    s('circle', { class: 'i-hot', cx: 33, cy: 48, r: 11 }),
    s('rect', { class: 'i-hot', x: 30, y: 22, width: 6, height: 24, rx: 3 }),
    s('path', { class: 'i-thin', d: 'M46 14h8M46 22h6M46 30h8' }),
  ],
  cough: () => [
    s('path', { class: 'i-fill', d: 'M30 8a18 18 0 0 0-18 18c0 6 2 9 4 12l-2 8h10v8h12a4 4 0 0 0 4-4v-6l6-2-4-8 2-2A18 18 0 0 0 30 8z' }),
    s('circle', { class: 'i-puff', cx: 50, cy: 28, r: 4 }),
    s('circle', { class: 'i-puff', cx: 58, cy: 20, r: 3 }),
    s('circle', { class: 'i-puff', cx: 58, cy: 36, r: 3 }),
  ],
  breath: () => [
    s('path', { class: 'i-thin', d: 'M32 6v20M32 26l-8 6M32 26l8 6' }),
    s('path', { class: 'i-fill', d: 'M22 20c-8 2-14 14-14 26 0 6 3 10 8 10 6 0 8-4 8-10V24c0-2-1-4-2-4zM42 20c8 2 14 14 14 26 0 6-3 10-8 10-6 0-8-4-8-10V24c0-2 1-4 2-4z' }),
  ],
  unwell: () => [
    s('circle', { class: 'i-fill', cx: 32, cy: 32, r: 24 }),
    s('path', { class: 'i-cut', d: 'M22 26h6M36 26h6M22 44q10-8 20 0' }),
  ],
};
function reportIcon(key) {
  const f = REPORT_ICONS[key] || REPORT_ICONS.unwell;
  return s('svg', { class: 'chip-ico', viewBox: '0 0 64 64', 'aria-hidden': 'true' }, f());
}

// ---------------------------------------------------------------- template: alert (posters 1 & 5)
let worldPromise = null;
function loadWorld() {
  if (!worldPromise) {
    worldPromise = fetch('data/world-110m.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  return worldPromise;
}

/** Mini map: the affected country, Taiwan and an arrival arc. Needs vendored d3 + topojson; silently omitted otherwise. */
async function drawMap(box, iso) {
  if (!iso || typeof d3 === 'undefined' || typeof topojson === 'undefined') return;
  const world = await loadWorld();
  if (!world?.objects?.countries) return;
  const all = topojson.feature(world, world.objects.countries).features;
  const target = all.find((f) => f.id === iso);
  const tw = all.find((f) => f.id === 'TW');
  if (!target || !tw) return;
  const W = 1000;
  const H = 400;
  const proj = d3.geoNaturalEarth1().fitExtent([[60, 60], [W - 60, H - 40]], { type: 'FeatureCollection', features: [target, tw] });
  const path = d3.geoPath(proj);
  const [x1, y1] = path.centroid(target);
  const [x2, y2] = path.centroid(tw);
  const bend = Math.min(220, Math.hypot(x2 - x1, y2 - y1) * 0.35);
  const cx = (x1 + x2) / 2;
  const cy = Math.min(y1, y2) - bend;
  const arcD = `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  const land = all.filter((f) => f !== target).map((f) => path(f)).filter(Boolean).join('');
  const plane = s('g', { class: 'map-plane' },
    s('path', { d: 'M-20 -3 4 -3 14 -16h6l-5 13h9l4-5h4l-3 8 3 8h-4l-4-5h-9l5 13h-6L4 3h-24z', transform: 'scale(-1 1)' }));  // nose to +x, the direction of travel
  const svg = s('svg', { class: 'map-svg', viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid meet' },
    s('path', { class: 'map-land', d: land }),
    s('path', { class: 'map-target', d: path(target) }),
    s('path', { class: 'map-tw', d: path(tw) }),
    s('circle', { class: 'map-ring', cx: x1, cy: y1, r: 26 }),
    s('circle', { class: 'map-ring map-ring-2', cx: x1, cy: y1, r: 26 }),
    s('path', { class: 'map-arc', d: arcD, pathLength: 1 }),
    s('path', { class: 'map-arc-flow', d: arcD }),
    s('circle', { class: 'map-dot', cx: x1, cy: y1, r: 9 }),
    s('circle', { class: 'map-tw-dot', cx: x2, cy: y2, r: 10 }),
    plane);
  box.append(svg);
  const arc = svg.querySelector('.map-arc-flow');
  const len = arc.getTotalLength();
  const place = (t) => {
    const p = arc.getPointAtLength(len * t);
    const q = arc.getPointAtLength(Math.min(len, len * t + 1));
    const r = arc.getPointAtLength(Math.max(0, len * t - 1));
    const ang = (Math.atan2(q.y - r.y, q.x - r.x) * 180) / Math.PI;
    plane.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${ang.toFixed(1)}) scale(1.6)`);
  };
  const REST = 0.86; // the plane parks just short of Taiwan so the island stays visible
  place(REST);
  // the controller calls this when the slide becomes active: the plane flies DRC -> Taiwan once, then rests
  box.closest('.slide').slideEnter = (still) => {
    if (still) { place(REST); return; }
    const t0 = performance.now() + 400;
    const step = (now) => {
      const k = Math.min(1, Math.max(0, (now - t0) / 1000));
      place(REST * (1 - (1 - k) ** 3));
      if (k < 1) requestAnimationFrame(step);
    };
    place(0);
    requestAnimationFrame(step);
  };
}

function alert(d, ctx) {
  const zh = d.lang !== 'en';
  const map = h('div', { class: 'al-map' });
  const el = h('div', { class: 'al' },
    h('div', { class: 'al-top' },
      s('svg', { class: 'al-wave', viewBox: '0 0 1000 200', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
        s('path', { class: 'al-wave-a', d: 'M0 90C180 10 330 10 520 80S860 170 1000 40V200H0z' }),
        s('path', { class: 'al-wave-b', d: 'M0 140C220 60 400 70 600 130S880 190 1000 110V200H0z' })),
      h('div', { class: 'al-burst fx-pop' }, burst(), h('span', { class: 'al-kicker', text: d.kicker || '' })),
      h('div', { class: 'al-title' },
        h('p', { class: 'al-cat fx-rise', style: delay(0.2), text: d.category || '' }),
        h('h2', { class: `al-disease fx-slam${zh ? '' : ' is-latin'}`, style: delay(0.28), text: d.disease || '' }))),
    d.iso ? map : null,
    h('div', { class: 'al-mid' },
      h('p', { class: 'al-region fx-rise', style: delay(0.42) }, pinIcon(), h('span', { text: d.region_label || '' })),
      h('p', { class: `al-country fx-rise${plain(d.country).length > 16 ? ' is-long' : ''}`, style: delay(0.5), text: d.country || '' }),
      d.country_en ? h('p', { class: 'al-country-en fx-rise', lang: 'en', style: delay(0.58), text: d.country_en }) : null,
      d.status ? h('p', { class: 'al-status fx-rise', style: delay(0.66) }, h('span', { class: 'al-who', lang: 'en', text: 'WHO' }), h('span', { text: plain(d.status).replace(/^WHO[:：]?\s*/, '') })) : null),
    h('div', { class: 'al-rule' },
      d.ask ? h('p', { class: 'al-ask fx-rise', style: delay(0.74) }, rich(d.ask)) : null,
      h('p', { class: 'al-must fx-rise', style: delay(0.84) }, rich(d.rule, 1)),
      d.note ? h('p', { class: 'al-note fx-rise', style: delay(0.94), text: d.note }) : null));
  ctx.wait.push(drawMap(map, typeof d.iso === 'string' ? d.iso.toUpperCase() : ''));
  return el;
}
function pinIcon() {
  return s('svg', { class: 'ico-pin', viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    s('path', { d: 'M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.6A2.6 2.6 0 1 1 12 6.4a2.6 2.6 0 0 1 0 5.2z' }));
}

// ---------------------------------------------------------------- template: symptoms (poster 2)
function symptoms(d) {
  const steps = Array.isArray(d.steps) ? d.steps : [];
  const list = Array.isArray(d.symptoms) ? d.symptoms : [];
  const mascot = assetSrc(d.mascot);
  return h('div', { class: 'sy' },
    s('svg', { class: 'sy-hills', viewBox: '0 0 1000 300', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      s('path', { class: 'sy-hill-a', d: 'M0 150C120 90 220 120 330 80S560 40 680 100 880 60 1000 90V300H0z' }),
      s('path', { class: 'sy-hill-b', d: 'M0 200C160 150 260 190 400 150S640 130 760 170 920 140 1000 160V300H0z' }),
      s('path', { class: 'sy-hill-c', d: 'M0 250C200 220 320 250 480 225S760 215 1000 240V300H0z' })),
    h('header', { class: 'sy-head' },
      h('h2', { class: 'sy-title fx-slam' }, plain(d.title).split(/\s+/).filter(Boolean).map((w) => h('span', { text: w }))),
      d.subtitle ? h('p', { class: 'sy-sub fx-rise', lang: 'en', style: delay(0.22), text: d.subtitle }) : null),
    h('div', { class: 'sy-body' },
      h('p', { class: 'sy-intro fx-rise', style: delay(0.3) },
        h('b', { text: plain(pick(d.intro, 'zh')) }),
        h('span', { lang: 'en', text: plain(pick(d.intro, 'en')) })),
      h('ul', { class: 'sy-grid' },
        list.map((x, i) => h('li', { class: 'sy-cell fx-pop', style: { ...delay(0.42 + i * 0.07), '--k': String(i) } },
          assetSrc(x.icon) ? h('img', { src: assetSrc(x.icon), alt: '', decoding: 'async' }) : null,
          h('b', { text: x.zh || '' }),
          h('span', { lang: 'en', text: x.en || '' })))),
      h('ol', { class: 'sy-steps' },
        steps.map((st, i) => h('li', { class: 'sy-step fx-rise', style: delay(0.8 + i * 0.12) },
          h('span', { class: 'sy-num', text: String(i + 1) }),
          h('div', { class: 'sy-step-t' },
            h('b', {}, rich(st.zh)),
            h('span', { lang: 'en' }, rich(st.en)),
            st.note ? h('small', {}, h('span', { text: plain(pick(st.note, 'zh')) }), ' ', h('span', { lang: 'en', text: plain(pick(st.note, 'en')) })) : null))))),
    mascot ? h('div', { class: 'sy-mascot fx-hop', style: delay(0.5) }, h('img', { src: mascot, alt: '', decoding: 'async' })) : null);
}

// ---------------------------------------------------------------- template: report (posters 3 & 4)
function counterScene(sign) {
  // flat illustration, viewBox 800x600: quarantine counter + officer on the left, traveller walks in from the right
  return s('svg', { class: 'rp-scene', viewBox: '0 0 800 600', 'aria-hidden': 'true' },
    s('rect', { class: 'sc-wall', x: 0, y: 0, width: 800, height: 600, rx: 36 }),
    s('path', { class: 'sc-floor', d: 'M0 470H800V564a36 36 0 0 1-36 36H36A36 36 0 0 1 0 564z' }),
    s('path', { class: 'sc-beam', d: 'M40 44H560l-22 26H40z' }),
    s('path', { class: 'sc-door', d: 'M590 470V120h150v350' }),
    s('g', { class: 'sc-officer' },
      s('path', { class: 'sc-off-body', d: 'M150 330c0-58 30-86 80-86s80 28 80 86z' }),
      s('path', { class: 'sc-off-tie', d: 'M222 252h16l-8 54z' }),
      s('circle', { class: 'sc-off-head', cx: 230, cy: 196, r: 44 }),
      s('path', { class: 'sc-off-hair', d: 'M186 196a44 44 0 0 1 88 0c-10-20-30-26-44-26s-34 6-44 26z' }),
      s('rect', { class: 'sc-off-mask', x: 202, y: 200, width: 56, height: 32, rx: 12 })),
    s('g', { class: 'sc-bubble' },
      s('circle', { class: 'sc-bub', cx: 110, cy: 150, r: 54 }),
      s('path', { class: 'sc-shield', d: 'M110 112l34 12v26c0 22-15 36-34 44-19-8-34-22-34-44v-26z' }),
      s('path', { class: 'sc-cross', d: 'M104 132h12v14h14v12h-14v14h-12v-14H90v-12h14z' })),
    s('rect', { class: 'sc-glass', x: 60, y: 238, width: 360, height: 92, rx: 10 }),
    s('path', { class: 'sc-desk', d: 'M40 330h420l-10 28H50z' }),
    s('path', { class: 'sc-front', d: 'M50 358h400v138a20 20 0 0 1-20 20H70a20 20 0 0 1-20-20z' }),
    s('text', { class: 'sc-sign-zh', x: 250, y: 440, 'text-anchor': 'middle', lang: 'zh-Hant', text: plain(pick(sign, 'zh')) || '旅客檢疫' }),
    s('text', { class: 'sc-sign-en', x: 250, y: 488, 'text-anchor': 'middle', lang: 'en', text: plain(pick(sign, 'en')) || 'Quarantine' }),
    s('ellipse', { class: 'sc-shadow', cx: 620, cy: 538, rx: 120, ry: 16 }),
    s('g', { class: 'sc-trav' },
      s('g', { class: 'sc-case' },
        s('rect', { class: 'sc-case-handle', x: 682, y: 300, width: 10, height: 84, rx: 5 }),
        s('rect', { class: 'sc-case-body', x: 650, y: 378, width: 108, height: 150, rx: 18 }),
        s('path', { class: 'sc-case-line', d: 'M678 396v114M704 396v114M730 396v114' }),
        s('circle', { class: 'sc-wheel', cx: 668, cy: 534, r: 9 }),
        s('circle', { class: 'sc-wheel', cx: 740, cy: 534, r: 9 })),
      s('g', { class: 'sc-leg sc-leg-b' }, s('path', { d: 'M612 420 640 528' })),
      s('g', { class: 'sc-leg sc-leg-a' }, s('path', { d: 'M596 420 566 528' })),
      s('rect', { class: 'sc-torso', x: 568, y: 268, width: 76, height: 168, rx: 34 }),
      s('path', { class: 'sc-pack', d: 'M630 282h34a10 10 0 0 1 10 10v92a10 10 0 0 1-10 10h-34z' }),
      s('g', { class: 'sc-arm sc-arm-a' }, s('path', { d: 'M584 300 548 376' })),
      s('path', { class: 'sc-arm-b', d: 'M626 300 686 306' }),
      s('circle', { class: 'sc-head', cx: 604, cy: 222, r: 38 })),
    s('g', { class: 'sc-heat' },
      s('circle', { class: 'sc-heat-bub', cx: 520, cy: 150, r: 46 }),
      s('rect', { class: 'sc-heat-stem', x: 512, y: 112, width: 16, height: 50, rx: 8 }),
      s('circle', { class: 'sc-heat-bulb', cx: 520, cy: 170, r: 14 }),
      s('rect', { class: 'sc-heat-fill', x: 516, y: 128, width: 8, height: 40, rx: 4 }),
      s('path', { class: 'sc-heat-wave', d: 'M566 112q8 10 0 20t0 20M582 104q8 10 0 20t0 20' })));
}

function report(d) {
  const zh = d.lang !== 'en';
  const syms = Array.isArray(d.symptoms) ? d.symptoms : [];
  return h('div', { class: `rp${zh ? '' : ' is-latin'}` },
    h('div', { class: 'rp-dots', 'aria-hidden': 'true' }),
    h('h2', { class: 'rp-head fx-slam' }, h('span', { text: d.headline || '' })),
    h('div', { class: 'rp-card' },
      h('ul', { class: 'rp-chips' },
        syms.map((x, i) => h('li', { class: 'rp-chip fx-pop', style: delay(0.32 + i * 0.1) }, reportIcon(x.icon), h('b', { text: x.t || '' })))),
      d.tail ? h('p', { class: 'rp-tail fx-rise', style: delay(0.36 + syms.length * 0.1) }, rich(d.tail)) : null,
      h('p', { class: 'rp-cond fx-rise', style: delay(0.72) }, rich(d.condition))),
    h('p', { class: 'rp-cta fx-rise', style: delay(0.88) }, rich(d.cta)),
    h('div', { class: 'rp-art' }, counterScene(d.sign)));
}

// ---------------------------------------------------------------- template: germs (poster 6)
function suitcase() {
  return s('svg', { class: 'gm-case', viewBox: '0 0 420 520', 'aria-hidden': 'true' },
    s('ellipse', { class: 'gm-shadow', cx: 210, cy: 500, rx: 170, ry: 16 }),
    s('path', { class: 'gm-handle', d: 'M150 150V70a20 20 0 0 1 20-20h80a20 20 0 0 1 20 20v80' }),
    s('rect', { class: 'gm-body', x: 60, y: 140, width: 300, height: 340, rx: 40 }),
    s('path', { class: 'gm-rib', d: 'M130 170v280M210 170v280M290 170v280' }),
    s('rect', { class: 'gm-tag', x: 230, y: 200, width: 110, height: 70, rx: 12, transform: 'rotate(8 285 235)' }),
    s('path', { class: 'gm-plane', d: 'M258 236h50l12-14h8l-6 14h12l6-6h6l-4 10 4 10h-6l-6-6h-12l6 14h-8l-12-14h-50z', transform: 'rotate(8 285 235)' }),
    s('circle', { class: 'gm-wheel', cx: 110, cy: 488, r: 14 }),
    s('circle', { class: 'gm-wheel', cx: 310, cy: 488, r: 14 }),
    germ('g1', 90, 150, 46, 0.4),
    germ('g2', 330, 120, 36, 0.5),
    germ('g3', 46, 330, 30, 0.6),
    germ('g4', 380, 380, 34, 0.7),
    germ('g5', 230, 92, 26, 0.8));
}
function noGerm() {
  return s('svg', { class: 'gm-no', viewBox: '0 0 200 200', 'aria-hidden': 'true' },
    s('circle', { class: 'gm-no-bg', cx: 100, cy: 100, r: 88 }),
    germ('g0', 100, 100, 46, 0),
    s('circle', { class: 'gm-no-ring', cx: 100, cy: 100, r: 82 }),
    s('path', { class: 'gm-no-bar', d: 'M42 42 158 158' }));
}
function germs(d) {
  const art = assetSrc(d.art);
  return h('div', { class: 'gm' },
    h('div', { class: 'gm-sky', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')),
    h('header', { class: 'gm-head' },
      h('div', { class: 'gm-sign fx-pop' }, noGerm()),
      h('h2', { class: 'gm-title' },
        h('span', { class: 'gm-zh fx-slam', lang: 'zh-Hant', text: plain(pick(d.headline, 'zh')) }),
        h('span', { class: 'gm-en fx-rise', lang: 'en', style: delay(0.28), text: plain(pick(d.headline, 'en')) }))),
    h('div', { class: 'gm-msg fx-rise', style: delay(0.45) },
      h('p', { class: 'gm-msg-zh', lang: 'zh-Hant' }, rich(pick(d.message, 'zh'))),
      h('p', { class: 'gm-msg-en', lang: 'en' }, rich(pick(d.message, 'en'), 1))),
    h('div', { class: 'gm-stage' },
      h('div', { class: 'gm-case-wrap fx-drop', style: delay(0.2) }, suitcase()),
      art ? h('div', { class: 'gm-pests fx-hop', style: delay(0.55) }, h('img', { src: art, alt: '', decoding: 'async' })) : null,
      h('div', { class: 'gm-buzz', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))));
}

// ---------------------------------------------------------------- template: image (whole poster, no template)
function image(d) {
  const src = assetSrc(d.src);
  return h('div', { class: 'im' },
    src ? h('img', { class: 'im-back', src, alt: '', decoding: 'async' }) : null,
    src ? h('div', { class: 'im-frame' }, h('img', { class: 'im-poster', src, alt: d.alt || '', decoding: 'async' })) : null);
}

const RENDER = { alert, symptoms, report, germs, image };

/** Build one slide section. ctx.wait collects promises (map) the caller may await before signalling "ready". */
export function renderSlide(d, brand, ctx) {
  const lang = ['zh', 'en', 'bi'].includes(d.lang) ? d.lang : 'zh';
  const sec = h('section', {
    class: `slide t-${d.template} l-${lang}`,
    lang: LANG_ATTR[lang],
    dataset: { id: d.id, testid: 'slide' },
    'aria-roledescription': 'slide',
    'aria-label': d.alt || plain(d.headline?.zh ?? d.headline) || plain(d.disease) || plain(d.title) || d.id,
  });
  sec.append(h('div', { class: 'slide-body' }, RENDER[d.template]({ ...d, lang }, ctx)));
  if (d.template !== 'image' || d.brand === true) sec.append(brandBar(brand));
  return sec;
}
