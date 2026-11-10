// Is this screen a kiosk? Same switches as js/osk.js: ?osk=1 (on-screen keyboard) or ?reset=N (idle reset), each
// kept for the browser session in sessionStorage; ?osk=0 / ?reset=0 turn them off.
const param = (name) => { try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; } };
const stored = (key) => { try { return sessionStorage.getItem(key); } catch (e) { return null; } };

export function isKiosk() {
  const osk = param('osk');
  const reset = param('reset');
  const keyboard = osk != null ? osk === '1' : stored('safetravel.osk') === '1';
  const idle = reset != null ? Number(reset) > 0 : Number(stored('safetravel.kiosk.reset')) > 0;
  return keyboard || idle;
}

/** ?name=1 → true, ?name=0 → false, anything else → null (no opinion). */
export function flagParam(name) {
  const v = param(name);
  return v === '1' ? true : v === '0' ? false : null;
}
