// Opt-in switches in the page address.
/** ?name=1 → true, ?name=0 → false, anything else → null (no opinion). */
export function flagParam(name) {
  let v = null;
  try { v = new URLSearchParams(location.search).get(name); } catch (e) { /* no address to read */ }
  return v === '1' ? true : v === '0' ? false : null;
}
