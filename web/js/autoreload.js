// Unattended screens (kiosks): reload the page when the site changes underneath it.
//
// version.json {"code": "<hash>"} is stamped by every deploy (.github/scripts/stamp-version.sh, and by the intranet
// mirror, scripts/mirror/safetravel-sync.sh): the hash covers the site's code files only, so it changes when the
// pages' code changes, not when data is refreshed. The committed file says "dev" (local preview: never reloads).
// data/meta.json generated_at changes with every data refresh (pages that show data can watch it too).
//
// A change only marks a reload as pending; the page reloads at a harmless moment: no pointer / keyboard activity for
// `idleMs` and the page's own quiet() check. Pages with a natural boundary (the poster carousel between two
// posters) call reloadIfPending() there instead. Hidden tabs do not poll.

const POLL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'];

async function readJSON(url) {
  try {
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch {
    return null; // offline / server hiccup: try again next time
  }
}
/** The deployed code version, or null when unknown; "dev" in a local checkout. */
export async function readCodeVersion() {
  const v = await readJSON('version.json');
  return typeof v?.code === 'string' && v.code ? v.code : null;
}
async function readDataVersion() {
  const m = await readJSON('data/meta.json');
  return typeof m?.generated_at === 'string' ? m.generated_at : null;
}

/**
 * @param {object} o
 * @param {boolean} [o.data]     also reload when data/meta.json generated_at changes
 * @param {number}  [o.idleMs]   no user activity for this long before reloading
 * @param {() => boolean} [o.quiet]  extra page-specific condition (e.g. "not paused on purpose")
 * @param {boolean} [o.daily]    reload once the page has been open for a day (long-running kiosks)
 * @param {() => void} [o.reload]
 */
/** Reload after re-downloading the page's scripts and stylesheets (js/boot-guard.js), so new site code never runs next
 *  to a stale cached module; plain reload when the guard script is missing. */
export const freshReload = () => (typeof window.safetravelFreshReload === 'function' ? window.safetravelFreshReload() : location.reload());

export function autoReload({ data = false, idleMs = 60_000, quiet = () => true, daily = true, reload = freshReload } = {}) {
  const q = Number(new URLSearchParams(location.search).get('refreshEvery')); // seconds; testing aid, as on index.html
  const pollMs = Number.isFinite(q) && q >= 1 ? q * 1000 : POLL_MS;
  const bootAt = Date.now();
  let lastActivity = 0;
  let base = { code: null, data: null };
  let pending = null;
  let gate = 0;
  ACTIVITY.forEach((type) => window.addEventListener(type, () => { lastActivity = Date.now(); }, { capture: true, passive: true }));

  const ready = (async () => {
    base = { code: await readCodeVersion(), data: data ? await readDataVersion() : null };
  })();

  function mark(reason) {
    if (pending) return;
    pending = { reason, since: Date.now() };
    document.documentElement.dataset.reloadPending = reason; // visible to tests / diagnostics
    gate = setInterval(() => {
      if (Date.now() - lastActivity >= idleMs && quiet()) doReload();
    }, 1000);
  }
  function doReload() {
    clearInterval(gate);
    pending.reloading = true;
    reload();
  }

  async function check() {
    await ready;
    if (pending || document.hidden) return pending?.reason || null;
    if (daily && Date.now() - bootAt > DAY_MS) { mark('daily'); return 'daily'; }
    const code = await readCodeVersion();
    if (code && code !== 'dev') {
      if (!base.code || base.code === 'dev') base.code = code; // first stamp seen: adopt as the baseline
      else if (code !== base.code) { mark('code'); return 'code'; }
    }
    if (data) {
      const gen = await readDataVersion();
      if (gen) {
        if (!base.data) base.data = gen;
        else if (gen !== base.data) { mark('data'); return 'data'; }
      }
    }
    return null;
  }

  setInterval(check, pollMs);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });

  return {
    check,
    get pending() { return pending && { ...pending }; },
    /** At a natural boundary (e.g. the next poster): reload now if an update is waiting. */
    reloadIfPending() {
      if (!pending || pending.reloading) return false;
      doReload();
      return true;
    },
  };
}
