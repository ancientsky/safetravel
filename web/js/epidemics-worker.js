// Fetches and parses epidemics.json off the main thread, then streams the items back in small
// batches so the page never blocks on one large JSON.parse / structured-clone task.
const BATCH = 250;

self.onmessage = async (event) => {
  const { url } = event.data || {};
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`epidemics.json: HTTP ${res.status}`);
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const rest = { ...data, items: undefined };
    self.postMessage({ type: 'meta', rest, total: items.length });
    for (let i = 0; i < items.length; i += BATCH) self.postMessage({ type: 'items', items: items.slice(i, i + BATCH) });
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
