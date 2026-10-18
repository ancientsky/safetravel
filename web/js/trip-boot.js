// trip.html: apply the stored theme / language before first paint (classic script, no inline code,
// so the page needs no extra CSP hash). Light is this page's default theme.
(function () {
  var d = document.documentElement, th = null, lg = null;
  try { th = localStorage.getItem('safetravel.trip.theme'); lg = localStorage.getItem('safetravel.lang'); } catch (e) {}
  d.setAttribute('data-theme', th === 'dark' ? 'dark' : 'light');
  // English visitors: keep the page hidden until trip.js has applied the strings (CSS reveals it after 3 s anyway)
  if (lg === 'en') { d.lang = 'en'; d.classList.add('i18n-pending'); }
})();
