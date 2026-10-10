// Canvas overlay: great-circle arcs from TPE with animated comet glyphs and a hub radar.
import { state } from './state.js';
import { reducedMotion, clamp } from './util.js';

const d3 = window.d3;
const MAX_GLYPHS = 150;
const TARGET_ALIVE_FULL = 120;
const SPEED = 0.5; // along-arc speed factor (1 = original pace)
const SAMPLES = 64;
const TRAIL_FULL = 7;
// Adaptive frame rate: low-end machines (or frames costing > SLOW_FRAME_MS of canvas work)
// draw at 30 fps; capable machines keep 60 fps.
const LOW_END = (navigator.hardwareConcurrency || 8) <= 4;
const SLOW_FRAME_MS = 8;
const LOW_FPS_INTERVAL = 1000 / 30;
// Low-end machines also get fewer comets, shorter trails and a cached (bitmap) arc layer.
const TARGET_ALIVE = LOW_END ? 70 : TARGET_ALIVE_FULL;
const TRAIL = LOW_END ? 4 : TRAIL_FULL;

export function createFlights({ canvas, map }) {
  const ctx = canvas.getContext('2d', { alpha: true });
  let dpr = 1;
  let W = 0;
  let H = 0;
  let routes = [];
  let hub = null;
  let enabled = true;
  let running = false;
  let lastTs = 0;
  let time = 0;
  let colors = {};
  let sprites = {};
  let spawnBase = 0;
  let frames = 0;
  let cost = 0;
  let fpsWindowStart = 0;
  let lowFps = LOW_END;
  // cached arc layer (used in 30 fps mode): re-rendered only when the view / theme / size changes
  const arcCanvas = document.createElement('canvas');
  const arcCtx = arcCanvas.getContext('2d');
  let arcKey = '';
  let lastDraw = 0;

  // Fixed object pools: no allocation in the animation loop.
  const glyphs = Array.from({ length: MAX_GLYPHS }, () => ({ on: false, ri: 0, out: true, t: 0, dur: 1 }));
  const pings = Array.from({ length: 40 }, () => ({ on: false, x: 0, y: 0, t: 0, out: true }));
  const posA = [0, 0];
  const posB = [0, 0];

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    colors = {
      out: v('--flight-out', '#19ff8a'),
      in: v('--flight-in', '#29e7ff'),
      arc: v('--flight-arc', 'rgba(25,255,138,0.5)'),
      hub: v('--home', '#29e7ff'),
      light: document.documentElement.dataset.theme === 'light',
    };
    sprites = { out: makeSprite(colors.out), in: makeSprite(colors.in), hub: makeSprite(colors.hub) };
  }

  function makeSprite(color) {
    const s = 64;
    const c = document.createElement('canvas');
    c.width = s;
    c.height = s;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.18, color);
    grad.addColorStop(0.45, withAlpha(color, 0.35));
    grad.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    return c;
  }

  function withAlpha(color, a) {
    const c = d3.color(color);
    if (!c) return color;
    c.opacity = a;
    return c.formatRgb();
  }

  function sizeCanvas() {
    // full-viewport canvas: window size avoids a forced layout read
    dpr = Math.min(LOW_END ? 1.5 : 2, window.devicePixelRatio || 1);
    W = Math.max(1, window.innerWidth);
    H = Math.max(1, window.innerHeight);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }

  /** Project every route once (unzoomed coordinates) with a lifted great-circle arc. */
  function build() {
    const f = state.data.flights;
    if (!f || !f.hub || !Array.isArray(f.routes)) { routes = []; hub = null; return; }
    const proj = map.projection;
    hub = proj([f.hub.lon, f.hub.lat]);
    const [mapW] = map.size();
    routes = f.routes.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)).map((r, i) => {
      const interp = d3.geoInterpolate([f.hub.lon, f.hub.lat], [r.lon, r.lat]);
      const raw = new Float32Array(SAMPLES * 2);
      for (let s = 0; s < SAMPLES; s++) {
        const p = proj(interp(s / (SAMPLES - 1)));
        raw[s * 2] = p[0];
        raw[s * 2 + 1] = p[1];
      }
      const x0 = raw[0];
      const y0 = raw[1];
      const x1 = raw[(SAMPLES - 1) * 2];
      const y1 = raw[(SAMPLES - 1) * 2 + 1];
      const chord = Math.hypot(x1 - x0, y1 - y0) || 1;
      // Normal of the chord, oriented "up" on screen, to lift the arc like a flight path.
      let nx = -(y1 - y0) / chord;
      let ny = (x1 - x0) / chord;
      if (ny > 0) { nx = -nx; ny = -ny; }
      const lift = Math.min(chord * 0.18, 70);
      const pts = new Float32Array(SAMPLES * 2);
      const breaks = new Uint8Array(SAMPLES);
      let len = 0;
      for (let s = 0; s < SAMPLES; s++) {
        const u = s / (SAMPLES - 1);
        const h = Math.sin(Math.PI * u) * lift;
        pts[s * 2] = raw[s * 2] + nx * h;
        pts[s * 2 + 1] = raw[s * 2 + 1] + ny * h;
        if (s > 0) {
          const dx = pts[s * 2] - pts[s * 2 - 2];
          const dy = pts[s * 2 + 1] - pts[s * 2 - 1];
          if (Math.abs(dx) > mapW * 0.4) breaks[s] = 1; // antimeridian jump
          else len += Math.hypot(dx, dy);
        }
      }
      const total = (r.departures || 0) + (r.arrivals || 0);
      return {
        r, pts, breaks, len,
        dur: clamp(1.8 + len / 210, 1.8, 7.5) / SPEED,
        width: 0.5 + Math.sqrt(total) * 0.32,
        phase: i * 1.7,
        accOut: Math.random(),
        accIn: Math.random(),
        dest: [pts[(SAMPLES - 1) * 2], pts[(SAMPLES - 1) * 2 + 1]],
      };
    });
    const load = routes.reduce((s, ro) => s + ((ro.r.departures || 0) + (ro.r.arrivals || 0)) * ro.dur, 0);
    spawnBase = load > 0 ? TARGET_ALIVE / load : 0;
    glyphs.forEach((g) => { g.on = false; });
    prefill();
  }

  function prefill() {
    if (reducedMotion()) return;
    let n = 0;
    for (const [ri, ro] of routes.entries()) {
      const expected = ((ro.r.departures || 0) + (ro.r.arrivals || 0)) * spawnBase * ro.dur;
      const count = Math.round(expected);
      for (let c = 0; c < count && n < TARGET_ALIVE; c++, n++) {
        const out = Math.random() < (ro.r.departures || 0) / ((ro.r.departures || 0) + (ro.r.arrivals || 0) || 1);
        spawn(ri, out, Math.random());
      }
    }
  }

  function spawn(ri, out, t0 = 0) {
    for (const g of glyphs) {
      if (!g.on) {
        g.on = true;
        g.ri = ri;
        g.out = out;
        g.t = t0;
        g.dur = routes[ri].dur * (0.9 + Math.random() * 0.2);
        return true;
      }
    }
    return false;
  }

  function ping(x, y, out) {
    for (const p of pings) {
      if (!p.on) { p.on = true; p.x = x; p.y = y; p.t = 0; p.out = out; return; }
    }
  }

  /** Position along a route at parameter u in [0,1], written into `into` (unzoomed coords). */
  function at(ro, u, into) {
    const f = clamp(u, 0, 1) * (SAMPLES - 1);
    const i = Math.min(SAMPLES - 2, Math.floor(f));
    const w = f - i;
    const p = ro.pts;
    into[0] = p[i * 2] + (p[i * 2 + 2] - p[i * 2]) * w;
    into[1] = p[i * 2 + 1] + (p[i * 2 + 3] - p[i * 2 + 1]) * w;
    return into;
  }

  function step(dt) {
    // spawn proportional to counts
    for (let ri = 0; ri < routes.length; ri++) {
      const ro = routes[ri];
      ro.accOut += (ro.r.departures || 0) * spawnBase * dt;
      ro.accIn += (ro.r.arrivals || 0) * spawnBase * dt;
      if (ro.accOut >= 1) { ro.accOut -= 1; spawn(ri, true); }
      if (ro.accIn >= 1) { ro.accIn -= 1; spawn(ri, false); }
    }
    for (const g of glyphs) {
      if (!g.on) continue;
      g.t += dt / g.dur;
      if (g.t >= 1) {
        g.on = false;
        const ro = routes[g.ri];
        if (g.out) ping(ro.dest[0], ro.dest[1], true);
        else ping(hub[0], hub[1], false);
      }
    }
    for (const p of pings) {
      if (p.on) { p.t += dt / 1.1; if (p.t >= 1) p.on = false; }
    }
  }

  function draw(animate) {
    const { k, x, y } = map.transform();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!routes.length || !hub) return;

    // --- arcs (zoomed coordinates) ---
    if (lowFps && animate) {
      // cheap path: one bitmap blit with a global "breathing" alpha instead of 55 strokes + dashes
      const key = `${k}|${x}|${y}|${W}|${H}|${dpr}|${colors.arc}|${colors.light}`;
      if (key !== arcKey) {
        arcKey = key;
        arcCanvas.width = canvas.width;
        arcCanvas.height = canvas.height;
        arcCtx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
        arcCtx.lineCap = 'round';
        arcCtx.strokeStyle = colors.arc;
        arcCtx.globalAlpha = colors.light ? 0.4 : 0.3;
        for (const ro of routes) {
          arcCtx.beginPath();
          tracePath(ro, arcCtx);
          arcCtx.lineWidth = ro.width / k;
          arcCtx.stroke();
        }
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 0.75 + 0.25 * Math.sin(time * 1.6);
      ctx.drawImage(arcCanvas, 0, 0);
      ctx.restore();
    }
    ctx.save();
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
    ctx.lineCap = 'round';
    for (const ro of (lowFps && animate) ? [] : routes) {
      const pulse = animate ? 0.5 + 0.5 * Math.sin(time * 1.6 + ro.phase) : 0.6;
      ctx.beginPath();
      tracePath(ro);
      ctx.strokeStyle = colors.arc;
      ctx.globalAlpha = (colors.light ? 0.28 : 0.16) + pulse * (colors.light ? 0.22 : 0.2);
      ctx.lineWidth = ro.width / k;
      ctx.stroke();
    }
    if (animate && !lowFps) {
      // flowing data-stream dashes (outbound direction)
      ctx.setLineDash([2.5 / k, 13 / k]);
      ctx.lineDashOffset = (-time * 26 * SPEED) / k;
      ctx.globalAlpha = colors.light ? 0.55 : 0.5;
      ctx.strokeStyle = colors.out;
      ctx.lineWidth = 1.1 / k;
      ctx.beginPath();
      for (const ro of routes) tracePath(ro);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    const sx = (px) => px * k + x;
    const sy = (py) => py * k + y;
    const hx = sx(hub[0]);
    const hy = sy(hub[1]);

    ctx.save();
    ctx.globalCompositeOperation = colors.light ? 'source-over' : 'lighter';

    // --- hub radar ---
    const R = 54;
    if (animate) {
      const ang = time * 1.4;
      if (ctx.createConicGradient) {
        const cg = ctx.createConicGradient(ang - 1.1, hx, hy);
        cg.addColorStop(0, withAlpha(colors.hub, 0));
        cg.addColorStop(0.17, withAlpha(colors.hub, colors.light ? 0.28 : 0.35));
        cg.addColorStop(0.175, withAlpha(colors.hub, 0));
        cg.addColorStop(1, withAlpha(colors.hub, 0));
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.arc(hx, hy, R, ang - 1.1, ang);
        ctx.closePath();
        ctx.fill();
      }
      for (let i = 0; i < 3; i++) {
        const ph = (time * 0.45 + i / 3) % 1;
        ctx.globalAlpha = (1 - ph) * 0.7;
        ctx.strokeStyle = colors.hub;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(hx, hy, 5 + ph * R, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = colors.hub;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.arc(hx, hy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.drawImage(sprites.hub, hx - 14, hy - 14, 28, 28);

    if (animate) {
      // --- landing pings ---
      for (const p of pings) {
        if (!p.on) continue;
        ctx.globalAlpha = (1 - p.t) * 0.8;
        ctx.strokeStyle = p.out ? colors.out : colors.in;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(sx(p.x), sy(p.y), 2 + p.t * 16, 0, Math.PI * 2);
        ctx.stroke();
      }

      // --- comets ---
      for (const g of glyphs) {
        if (!g.on) continue;
        const ro = routes[g.ri];
        const sprite = g.out ? sprites.out : sprites.in;
        const dir = g.out ? 1 : -1;
        const u = g.out ? g.t : 1 - g.t;
        // fade in/out at the ends
        const edge = Math.min(1, g.t * 8, (1 - g.t) * 8);
        for (let j = TRAIL; j >= 1; j--) {
          at(ro, u - dir * j * 0.011, posA);
          const a = (1 - j / (TRAIL + 1)) * 0.55 * edge;
          const s = (11 - j) * 0.9;
          ctx.globalAlpha = a;
          ctx.drawImage(sprite, sx(posA[0]) - s / 2, sy(posA[1]) - s / 2, s, s);
        }
        at(ro, u, posA);
        at(ro, u + dir * 0.004, posB);
        const px = sx(posA[0]);
        const py = sy(posA[1]);
        ctx.globalAlpha = edge;
        ctx.drawImage(sprite, px - 9, py - 9, 18, 18);
        // tiny plane silhouette pointing along the route
        const ang = Math.atan2(sy(posB[1]) - py, sx(posB[0]) - px);
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang);
        ctx.fillStyle = colors.light ? (g.out ? colors.out : colors.in) : '#ffffff';
        ctx.beginPath();
        ctx.moveTo(4.5, 0);
        ctx.lineTo(-3, -3);
        ctx.lineTo(-1.5, 0);
        ctx.lineTo(-3, 3);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  function tracePath(ro, c = ctx) {
    const p = ro.pts;
    c.moveTo(p[0], p[1]);
    for (let s = 1; s < SAMPLES; s++) {
      if (ro.breaks[s]) c.moveTo(p[s * 2], p[s * 2 + 1]);
      else c.lineTo(p[s * 2], p[s * 2 + 1]);
    }
  }

  function loop(ts) {
    if (!running) return;
    if (lowFps && lastDraw && ts - lastDraw < LOW_FPS_INTERVAL - 4) { // skip alternate frames
      requestAnimationFrame(loop);
      return;
    }
    lastDraw = ts;
    const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;
    time += dt;
    const c0 = performance.now();
    step(dt);
    draw(true);
    cost += performance.now() - c0;
    frames++;
    state.frames = (state.frames || 0) + 1; // drawn-frame counter (diagnostics / tests)
    if (!fpsWindowStart) fpsWindowStart = ts;
    if (ts - fpsWindowStart >= 1000) {
      state.fps = Math.round((frames * 1000) / (ts - fpsWindowStart));
      state.frameMs = +(cost / frames).toFixed(2);
      if (!lowFps && state.frameMs > SLOW_FRAME_MS) lowFps = true;
      else if (lowFps && !LOW_END && state.frameMs < SLOW_FRAME_MS / 3) lowFps = false;
      state.fpsMode = lowFps ? 30 : 60;
      cost = 0;
      frames = 0;
      fpsWindowStart = ts;
    }
    requestAnimationFrame(loop);
  }

  function start() {
    if (!enabled || !routes.length || document.hidden) return;
    if (reducedMotion()) { running = false; draw(false); return; }
    if (running) return;
    running = true;
    lastTs = 0;
    lastDraw = 0;
    fpsWindowStart = 0;
    frames = 0;
    requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function setEnabled(on) {
    enabled = on;
    canvas.hidden = !on;
    if (on) start();
    else stop();
  }

  // Stop the loop while the tab is hidden; resume cleanly (fresh timestamps) when visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) running = false;
    else if (enabled) start();
  });

  map.onZoom(() => { if (enabled && !running && !document.hidden) draw(false); });
  map.onResize(() => { arcKey = ''; sizeCanvas(); build(); if (enabled && !running) draw(false); });

  function init() {
    sizeCanvas();
    readColors();
    build();
    start();
  }

  return {
    init,
    setEnabled,
    refreshTheme: () => { arcKey = ''; readColors(); if (enabled && !running) draw(false); },
    stats: () => ({ active: glyphs.filter((g) => g.on).length, routes: routes.length }),
  };
}
