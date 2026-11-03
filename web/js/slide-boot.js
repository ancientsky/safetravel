// slide.html: apply the stored theme / UI language before first paint (classic script, no inline code,
// so the page keeps trip.html's CSP). Dark is this page's default theme; the posters keep their own colours.
(function () {
  var d = document.documentElement, th = null, lg = null, q = null;
  try { th = localStorage.getItem('safetravel.slide.theme'); lg = localStorage.getItem('safetravel.lang'); } catch (e) {}
  try { q = new URLSearchParams(location.search); } catch (e) {}
  if (q && q.get('lang') === 'en') lg = 'en';
  if (q && q.get('lang') === 'zh') lg = 'zh-Hant';
  d.setAttribute('data-theme', th === 'light' ? 'light' : 'dark');
  if (lg === 'en') d.lang = 'en';
  if (q && q.get('still') === '1') d.classList.add('still'); // export / screenshot mode: final animation state
  var o = q && q.get('orient');
  if (o !== 'landscape' && o !== 'auto') { try { o = localStorage.getItem('safetravel.slide.orient'); } catch (e) {} }
  if (o === 'auto') o = innerWidth > innerHeight ? 'landscape' : 'portrait';
  d.setAttribute('data-orient', o === 'landscape' ? 'landscape' : 'portrait');
})();
