// Unattended auto-refresh: poll meta.json and reload the page at a quiet moment when new data
// has been published (or once the page has been open for more than a day).
import { on, emit } from './state.js';
import { t } from './i18n.js';
import { toast } from './toast.js';

const CHECK_EVERY_S = 300; // poll interval; override with ?refreshEvery=<seconds> for manual testing
const FALLBACK_MS = 60_000; // reload after this long if no spotlight cycle comes along
const IDLE_MS = 30_000; // pointer/keyboard activity within this window counts as "in use"
const MAX_DEFER_MS = 120_000; // activity can postpone the reload by at most this much
const MAX_AGE_MS = 24 * 3600_000; // daily safety net
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];

export function startRefresh({ generatedAt, reload = () => location.reload() } = {}) {
  const override = Number(new URLSearchParams(location.search).get('refreshEvery'));
  const everyMs = (Number.isFinite(override) && override >= 1 ? override : CHECK_EVERY_S) * 1000;
  const bootAt = Date.now();
  let lastActivity = 0;
  let lastMeta = generatedAt || null;
  let pending = null; // { reason, since, cycled, deferStart }
  let gate = 0;

  ACTIVITY_EVENTS.forEach((type) => window.addEventListener(type, () => { lastActivity = Date.now(); }, { capture: true, passive: true }));

  async function check() {
    try {
      const res = await fetch(`data/meta.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return false;
      const meta = await res.json();
      const gen = meta?.generated_at;
      if (!gen) return false;
      if (!lastMeta) { lastMeta = gen; return false; } // startup meta was missing: adopt as baseline
      if (gen !== lastMeta) {
        schedule('data', gen);
        return true;
      }
    } catch { /* offline / server hiccup: try again next tick */ }
    return false;
  }

  function schedule(reason, gen) {
    if (pending) return;
    pending = { reason, gen, since: Date.now(), cycled: false, deferStart: 0 };
    if (reason === 'data') {
      toast(t('refresh_new_data'), 'info', 0);
      emit('refresh:pending');
    }
    gate = setInterval(maybeReload, 1000);
  }

  // A quiet moment = the next spotlight cycle boundary, or FALLBACK_MS after detection;
  // recent user activity postpones it, but never by more than MAX_DEFER_MS.
  function maybeReload() {
    if (!pending) return;
    const now = Date.now();
    if (!pending.cycled && now - pending.since < FALLBACK_MS) return;
    if (now - lastActivity < IDLE_MS) {
      if (!pending.deferStart) pending.deferStart = now;
      if (now - pending.deferStart < MAX_DEFER_MS) return;
    }
    clearInterval(gate);
    pending.reloading = true;
    reload();
  }

  on('spotlight:cycle', () => {
    if (!pending) return;
    pending.cycled = true;
    maybeReload();
  });

  setInterval(() => {
    if (!pending && Date.now() - bootAt > MAX_AGE_MS) schedule('daily');
    else check();
  }, everyMs);

  return {
    check,
    everyMs,
    get lastMeta() { return lastMeta; },
    get pending() { return pending && { ...pending }; },
  };
}
