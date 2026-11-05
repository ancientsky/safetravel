// help.html: show the Chinese or English block (same key as every other page), theme and language buttons.
// The content itself is static HTML in help.html — keep both languages in step when features change.
import { storageGet, storageSet } from './util.js';

// js/boot-guard.js: this module and all its imports loaded and linked (no half-updated cache)
document.documentElement.dataset.booted = '1';

const LANG_KEY = 'safetravel.lang';
const THEME_KEY = 'safetravel.m.theme';
const root = document.documentElement;

function followHash(en) {
  // deep links are written for the Chinese ids (help.html#sources): follow them in English too
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h) return;
  const id = en ? (h.startsWith('en-') ? h : `en-${h}`) : h.replace(/^en-/, '');
  document.getElementById(id)?.scrollIntoView();
}

function showLang(en) {
  root.lang = en ? 'en' : 'zh-Hant';
  document.querySelector('[data-lang="zh"]').hidden = en;
  document.querySelector('[data-lang="en"]').hidden = !en;
  document.title = en ? 'Help · SafeTravel TW' : '使用說明 · SafeTravel TW';
  followHash(en);
}
window.addEventListener('hashchange', () => followHash(root.lang === 'en'));

// phones show table rows as cards: label each cell with its column heading
document.querySelectorAll('.help table').forEach((table) => {
  const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  table.querySelectorAll('tbody tr').forEach((tr) => {
    [...tr.children].forEach((td, i) => { if (heads[i]) td.dataset.label = heads[i]; });
  });
});

showLang(storageGet(LANG_KEY) === 'en');
root.classList.remove('i18n-pending');
document.querySelector('[data-testid="lang-toggle"]').addEventListener('click', () => {
  const en = root.lang !== 'en';
  storageSet(LANG_KEY, en ? 'en' : 'zh-Hant');
  showLang(en);
});
document.querySelector('[data-testid="theme-toggle"]').addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  storageSet(THEME_KEY, next);
});
document.body.dataset.ready = '1';
