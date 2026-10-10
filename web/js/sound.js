// Ambient / UI sound design, synthesised with the Web Audio API (no audio files, no fetches).
// Nothing is created while sound is OFF; the AudioContext is made lazily the first time it's needed.
import { t } from './i18n.js';
import { storageGet, storageSet } from './util.js';

const KEY = 'safetravel.sound';
const MASTER = 0.35; // master volume
const DRONE = 0.16; // drone bus level; one-shot peaks stay within ~+6 dB of it
const MAX_VOICES = 8;
const TICK_GAP_MS = 120;
const REVERB_S = 3.5;

export function createSound({ button }) {
  let enabled = storageGet(KEY) === 'on';
  let ctx = null;
  let master = null;
  let analyser = null;
  let reverbIn = null;
  let noiseBuf = null;
  let drone = null; // { nodes: [...], out: GainNode }
  let windTimer = 0;
  let voices = 0;
  let lastTick = 0;
  let nextBlipAt = 0;
  let unlockArmed = false;
  let blips = 0; // diagnostics

  // ---------- graph ----------
  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC({ latencyHint: 'playback' });
    master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.01;
    comp.release.value = 0.4;
    analyser = ctx.createAnalyser(); // diagnostics only (RMS / peak for tests)
    analyser.fftSize = 2048;
    master.connect(comp).connect(analyser).connect(ctx.destination);

    // cavernous shared reverb: decaying stereo noise impulse response, generated in code
    const conv = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * REVERB_S);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    }
    conv.buffer = ir;
    reverbIn = ctx.createGain();
    reverbIn.gain.value = 0.55;
    reverbIn.connect(conv).connect(master);

    // shared 2 s noise buffer for wind / whoosh
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    ctx.addEventListener('statechange', syncButton);
    return ctx;
  }

  const running = () => !!ctx && ctx.state === 'running' && enabled && !document.hidden;

  /** Route a voice's output to dry + reverb, count it, and tear it down when its source ends. */
  function voice(out, src, { wet = 0.6, pan = 0, nodes = [] } = {}) {
    voices++;
    let node = out;
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      out.connect(p);
      node = p;
      nodes.push(p);
    }
    node.connect(master);
    const send = ctx.createGain();
    send.gain.value = wet;
    node.connect(send).connect(reverbIn);
    nodes.push(out, send);
    src.onended = () => {
      voices = Math.max(0, voices - 1);
      [src, ...nodes].forEach((n) => { try { n.disconnect(); } catch { /* already */ } });
    };
  }

  function tone(freq, { type = 'sine', at = 0, attack = 0.005, decay = 1.6, gain = 0.2, wet = 0.6, pan = 0 } = {}) {
    if (!running() || voices >= MAX_VOICES) return;
    const t0 = ctx.currentTime + at;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    o.connect(g);
    voice(g, o, { wet, pan });
    o.start(t0);
    o.stop(t0 + attack + decay + 0.05);
  }

  function noise({ dur = 1, from = 3000, to = 300, q = 1.2, peak = 0.08, rise = 0.8, wet = 0.7, type = 'bandpass' } = {}) {
    if (!running() || voices >= MAX_VOICES) return;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = dur > 2;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t0);
    f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + dur * rise);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g);
    voice(g, src, { wet, nodes: [f] });
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  // ---------- ambient bed ----------
  function startDrone() {
    if (drone || !ctx) return;
    const t0 = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = DRONE;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    lp.Q.value = 0.7;
    const oscs = [
      [55, 'sine', 0.55], [55 * 1.004, 'triangle', 0.35], [82.41, 'sine', 0.3], [82.41 * 0.997, 'triangle', 0.18],
    ].map(([f, type, g]) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(lp);
      o.start(t0);
      return [o, og];
    });
    // very quiet high shimmer, around the lowpass straight into the reverb
    const sh = ctx.createOscillator();
    sh.type = 'sine';
    sh.frequency.value = 1760;
    const shg = ctx.createGain();
    shg.gain.value = 0.012;
    sh.connect(shg).connect(reverbIn);
    sh.start(t0);
    // slow "breathing": LFOs on the cutoff (16 s) and on the level (13 s)
    const lfo1 = ctx.createOscillator();
    lfo1.frequency.value = 1 / 16;
    const lfo1g = ctx.createGain();
    lfo1g.gain.value = 180;
    lfo1.connect(lfo1g).connect(lp.frequency);
    const breathe = ctx.createGain();
    breathe.gain.value = 0.75;
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 1 / 13;
    const lfo2g = ctx.createGain();
    lfo2g.gain.value = 0.25;
    lfo2.connect(lfo2g).connect(breathe.gain);
    lfo1.start(t0);
    lfo2.start(t0);
    lp.connect(breathe).connect(out);
    out.connect(master);
    const send = ctx.createGain();
    send.gain.value = 0.35;
    out.connect(send).connect(reverbIn);
    drone = { out, nodes: [lp, breathe, send, shg, lfo1g, lfo2g, ...oscs.flat()], srcs: [...oscs.map(([o]) => o), sh, lfo1, lfo2] };
    scheduleWind();
  }

  function stopDrone() {
    clearTimeout(windTimer);
    if (!drone) return;
    const d = drone;
    drone = null;
    d.srcs.forEach((s) => { try { s.stop(); } catch { /* stopped */ } });
    [...d.srcs, ...d.nodes, d.out].forEach((n) => { try { n.disconnect(); } catch { /* done */ } });
  }

  // occasional faint filtered-noise "wind" swells every 20–40 s
  function scheduleWind() {
    clearTimeout(windTimer);
    windTimer = setTimeout(() => {
      noise({ dur: 6 + Math.random() * 3, from: 380, to: 900 + Math.random() * 500, q: 3, peak: 0.07, rise: 0.5, wet: 0.9 });
      scheduleWind();
    }, 20000 + Math.random() * 20000);
  }

  // ---------- one-shots ----------
  const sounds = {
    // sonar ping by advisory level
    ping(level = 1) {
      if (level >= 3) {
        tone(196, { decay: 2.6, gain: 0.26, wet: 0.8 });
        tone(196 * 1.0595, { at: 0.04, decay: 2.2, gain: 0.07, wet: 0.9 }); // minor second
        tone(196 * Math.SQRT2, { at: 0.35, decay: 2.0, gain: 0.05, wet: 0.9 }); // tritone
      } else if (level === 2) {
        tone(587, { decay: 2.0, gain: 0.22, wet: 0.75 });
        tone(587 * 2.01, { at: 0.02, decay: 1.2, gain: 0.05, wet: 0.8 });
      } else {
        tone(1046, { decay: 1.7, gain: 0.18, wet: 0.75 });
      }
    },
    chime() { // soft glass chime
      [[1568, 0.07, 2.6], [2349, 0.045, 2.0], [3136, 0.03, 1.6]].forEach(([f, g, d], i) => tone(f, { at: i * 0.012, decay: d, gain: g, wet: 0.9 }));
    },
    whoosh() { // short soft reverse whoosh, swept down
      noise({ dur: 0.55, from: 3200, to: 260, q: 0.9, peak: 0.12, rise: 0.85, wet: 0.5 });
    },
    tick() {
      const now = performance.now();
      if (now - lastTick < TICK_GAP_MS) return;
      lastTick = now;
      tone(2600, { attack: 0.002, decay: 0.03, gain: 0.025, wet: 0.2 });
    },
    click() { tone(1400, { type: 'triangle', attack: 0.002, decay: 0.045, gain: 0.05, wet: 0.15 }); },
    blip(pan = 0) { // faint radio blip
      const f = 1900 + Math.random() * 500;
      tone(f, { attack: 0.004, decay: 0.05, gain: 0.03, wet: 0.5, pan });
      tone(f * 1.26, { at: 0.09, attack: 0.004, decay: 0.05, gain: 0.025, wet: 0.5, pan });
    },
    arpeggio() { // gentle rising three notes
      [523.25, 659.25, 783.99].forEach((f, i) => tone(f, { type: 'triangle', at: i * 0.2, decay: 1.6, gain: 0.12, wet: 0.8 }));
    },
  };

  function play(name, arg) {
    if (!enabled || !ctx) return;
    sounds[name]?.(arg);
  }

  /** Radio blip driven by real plane landings (rate-limited to one every 8–15 s). */
  function landing(xNorm) {
    if (!running()) return;
    const now = performance.now();
    if (now < nextBlipAt) return;
    nextBlipAt = now + 8000 + Math.random() * 7000;
    blips++;
    sounds.blip(xNorm * 2 - 1);
  }

  // ---------- on / off, autoplay ----------
  function fadeTo(value, seconds) {
    const t0 = ctx.currentTime;
    master.gain.cancelScheduledValues(t0);
    master.gain.setValueAtTime(master.gain.value, t0);
    master.gain.linearRampToValueAtTime(value, t0 + seconds);
  }

  // Start the bed only once the context really runs (no node.start() on a blocked context,
  // which would make Chrome log an autoplay warning per node).
  function begin() {
    if (!enabled || !ctx || ctx.state !== 'running') return;
    startDrone();
    fadeTo(MASTER, 3);
    syncButton();
  }

  function armUnlock() {
    if (unlockArmed) return;
    unlockArmed = true;
    const unlock = () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      unlockArmed = false;
      if (!enabled || document.hidden) return;
      if (!ensureCtx()) return;
      ctx.resume().then(begin, syncButton);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  /** Resolve when the context is running, or after `ms` (autoplay blocked). */
  function waitRunning(ms) {
    return new Promise((resolve) => {
      if (ctx.state === 'running') { resolve(); return; }
      const done = () => { ctx.removeEventListener('statechange', onChange); clearTimeout(timer); resolve(); };
      const onChange = () => { if (ctx.state === 'running') done(); };
      const timer = setTimeout(done, ms);
      ctx.addEventListener('statechange', onChange);
    });
  }

  async function turnOn() {
    if (!ensureCtx()) return;
    if (ctx.state !== 'running' && !document.hidden) {
      const gesture = navigator.userActivation ? navigator.userActivation.isActive : true;
      // with a user gesture (the toggle click) resume() works; without one, only wait and see
      // whether the browser allows autoplay (e.g. --autoplay-policy=no-user-gesture-required)
      if (gesture) await ctx.resume().catch(() => {});
      else await waitRunning(500);
    }
    if (ctx.state === 'running') begin();
    else armUnlock();
    syncButton();
  }

  function turnOff() {
    if (!ctx) { syncButton(); return; }
    fadeTo(0, 1.5);
    setTimeout(() => {
      if (enabled || !ctx) return;
      stopDrone();
      ctx.suspend().catch(() => {});
      syncButton();
    }, 1600);
    syncButton();
  }

  function syncButton() {
    if (!button) return;
    const waiting = enabled && (!ctx || ctx.state !== 'running') && !document.hidden;
    button.setAttribute('aria-pressed', String(enabled));
    button.classList.toggle('is-waiting', waiting);
    const hint = waiting ? t('sound_hint') : '';
    button.title = hint || t('sound_title');
    const sr = button.querySelector('.sound-sr');
    if (sr) sr.textContent = ` — ${hint || t('sound_title')}`;
  }

  button?.addEventListener('click', () => {
    enabled = !enabled;
    storageSet(KEY, enabled ? 'on' : 'off');
    if (enabled) turnOn(); else turnOff();
  });

  document.addEventListener('visibilitychange', () => {
    if (!ctx || !enabled) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else if (drone) ctx.resume().then(syncButton, () => armUnlock());
    syncButton();
  });

  if (enabled) {
    // Prefer not to create a context the browser will refuse: ask first where supported.
    const policy = navigator.getAutoplayPolicy?.('audiocontext');
    if (policy === 'disallowed') {
      syncButton();
      armUnlockDeferred();
    } else {
      turnOn();
    }
  } else {
    syncButton();
  }

  // stored ON but autoplay disallowed: build the graph on the first gesture
  function armUnlockDeferred() {
    const go = () => {
      window.removeEventListener('pointerdown', go, true);
      window.removeEventListener('keydown', go, true);
      if (enabled) turnOn();
    };
    window.addEventListener('pointerdown', go, true);
    window.addEventListener('keydown', go, true);
  }

  function level() {
    if (!analyser) return { rms: 0, peak: 0 };
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    let peak = 0;
    for (const v of buf) { sum += v * v; peak = Math.max(peak, Math.abs(v)); }
    return { rms: Math.sqrt(sum / buf.length), peak };
  }

  return {
    play,
    landing,
    refresh: syncButton,
    isOn: () => enabled,
    debug: {
      state: () => ({ enabled, ctx: ctx ? ctx.state : 'none', voices, drone: !!drone, blips, waiting: button?.classList.contains('is-waiting') }),
      level,
      play: (name, arg) => { if (ctx) sounds[name]?.(arg); },
    },
  };
}
