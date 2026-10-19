// Fetches and parses epidemics.json off the main thread, then streams the items back in small
// batches so the page never blocks on one large JSON.parse / structured-clone task.
// ~45 KB per message: receiving a message deserialises it on the main thread, so keep each one short.
const BATCH = 60;
const OVERVIEW_BATCH = 40;

self.onmessage = async (event) => {
  const { url } = event.data || {};
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`epidemics.json: HTTP ${res.status}`);
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const overviews = Object.entries(data.overviews || {});
    const rest = { ...data, items: undefined, overviews: undefined };
    self.postMessage({ type: 'meta', rest, total: items.length });
    for (let i = 0; i < overviews.length; i += OVERVIEW_BATCH) {
      self.postMessage({ type: 'overviews', overviews: overviews.slice(i, i + OVERVIEW_BATCH) });
    }
    for (let i = 0; i < items.length; i += BATCH) self.postMessage({ type: 'items', items: items.slice(i, i + BATCH) });
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
