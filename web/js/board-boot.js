// arrivals.html: apply the stored theme / language before first paint (classic script, no inline code, so the page
// needs no CSP hash). Same keys as the map page, so a kiosk keeps one look across both.
(function () {
  var d = document.documentElement, th = null, lg = null;
  try { th = localStorage.getItem('safetravel.theme'); lg = localStorage.getItem('safetravel.lang'); } catch (e) {}
  d.setAttribute('data-theme', th === 'light' ? 'light' : 'dark');
  if (lg === 'en') { d.lang = 'en'; d.classList.add('i18n-pending'); }
})();
