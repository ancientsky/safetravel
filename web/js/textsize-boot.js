// Text size before first paint (index.html, trip.html): sets data-ts on <html>; the stylesheets turn it into --ts,
// which multiplies every font size. Classic external script, so the CSP needs no extra hash.
// Order: ?text=s|m|l|xl (kiosk URL, not stored) > localStorage 'safetravel.textSize' > default:
// 'm' (112 %) on screens wider than 760 px, 's' (100 %) on phones, whose layout is already tight.
(function () {
  var ok = /^(s|m|l|xl)$/, v = null;
  try { v = new URLSearchParams(location.search).get('text'); } catch (e) {}
  if (!ok.test(v || '')) { try { v = localStorage.getItem('safetravel.textSize'); } catch (e) {} }
  if (!ok.test(v || '')) v = (window.innerWidth || 1024) <= 760 ? 's' : 'm';
  document.documentElement.setAttribute('data-ts', v);
})();
