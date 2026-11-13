// Every page (classic script, no CSP hash needed). Two guards.
//
// 1. Framed by another website (clickjacking). GitHub Pages cannot send X-Frame-Options or frame-ancestors, and a
//    <meta> CSP cannot carry frame-ancestors (the intranet mirror's nginx sends both). So when this page sits in a frame
//    whose top page is another origin, it leaves for framed.html — a static notice with a link that opens the site
//    itself — before any page code draws. Frames on the same origin are allowed, like frame-ancestors 'self'.
//    "localhost" is exempt so a development preview pane can show the pages.
(function () {
  if (window.top === window.self || location.hostname === 'localhost') return;
  try { if (window.top.location.origin === location.origin) return; } catch (e) { /* another origin: reading it throws */ }
  window.safetravelFramed = true;
  document.documentElement.style.display = 'none';
  location.replace('framed.html');
})();

// 2. Recover from a half-updated browser cache.
// GitHub Pages lets browsers keep each file for 10 minutes. Right after a deploy a browser can hold an old copy of one
// module next to the new copy of another; the new one may import something the old one lacks, and then the page's
// whole module graph refuses to start (blank page, as on 2026-11-05). Each page's entry module marks <html data-booted>
// as its first act. If the page has loaded and that mark is missing, re-download every script / stylesheet the page
// used straight from the server (cache: 'reload' also refreshes the browser cache) and reload — at most twice per tab
// session, so a real bug can never cause a reload loop.
(function () {
  var KEY = 'safetravel.recover';
  function sameSite(u) {
    try { return !!u && new URL(u).origin === location.origin && u.indexOf('/data/') < 0; } catch (e) { return false; }
  }
  function urls() {
    var out = [];
    try {
      performance.getEntriesByType('resource').forEach(function (e) {
        if (/\.(m?js|css)(\?|#|$)/.test(e.name) && sameSite(e.name)) out.push(e.name);
      });
    } catch (e) { /* no resource timing */ }
    var tags = document.querySelectorAll('script[src], link[rel="stylesheet"]');
    for (var i = 0; i < tags.length; i++) {
      var u = tags[i].src || tags[i].href;
      if (sameSite(u) && out.indexOf(u) < 0) out.push(u);
    }
    return out;
  }
  function freshReload() {
    var jobs = urls().map(function (u) { return fetch(u, { cache: 'reload' }).catch(function () {}); });
    return Promise.all(jobs).then(function () { location.reload(); });
  }
  window.safetravelFreshReload = freshReload;
  window.addEventListener('load', function () {
    if (window.safetravelFramed) return; // on its way to framed.html
    setTimeout(function () {
      var n = 0;
      try { n = Number(sessionStorage.getItem(KEY)) || 0; } catch (e) { /* storage blocked */ }
      if (document.documentElement.hasAttribute('data-booted')) {
        if (n) { try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ } }
        return;
      }
      if (n >= 2) return; // tried twice already: leave the page as it is
      try { sessionStorage.setItem(KEY, String(n + 1)); } catch (e) { return; } // no storage: no safe loop guard
      freshReload();
    }, 1500);
  });
})();
