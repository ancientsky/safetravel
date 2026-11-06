// Every page except slide.html (which has its own): ?lang=en / ?lang=zh pins the language for this visit, before
// first paint (classic script, no CSP hash needed). Runs after the page's own boot script and overrides what it set
// from the stored language. Not stored: a kiosk link keeps its language while the screen's own choice stays as is.
(function () {
  var q = null;
  try { q = (new URLSearchParams(location.search).get('lang') || '').toLowerCase(); } catch (e) { return; }
  var d = document.documentElement;
  if (q === 'en') { d.lang = 'en'; d.classList.add('i18n-pending'); }
  else if (q === 'zh' || q === 'zh-hant' || q === 'zh-tw') { d.lang = 'zh-Hant'; d.classList.remove('i18n-pending'); }
})();
