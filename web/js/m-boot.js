// m.html: theme / language before first paint (classic script, no inline code, so the CSP needs no hash).
// The phone page follows the device's light / dark setting unless the visitor picked one on this page.
(function () {
  var d = document.documentElement, th = null, lg = null;
  try { th = localStorage.getItem('safetravel.m.theme'); lg = localStorage.getItem('safetravel.lang'); } catch (e) {}
  if (th !== 'light' && th !== 'dark') {
    th = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  d.setAttribute('data-theme', th);
  if (lg === 'en') { d.lang = 'en'; d.classList.add('i18n-pending'); }
})();
