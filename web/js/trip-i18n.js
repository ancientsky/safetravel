// trip.html i18n: dictionary lookup plus level / name helpers for both rating systems.
import zh from '../i18n/trip-zh-Hant.js';
import en from '../i18n/trip-en.js';
import { storageGet, storageSet, clean } from './util.js';

const DICTS = { 'zh-Hant': zh, en };
const LANG_KEY = 'safetravel.lang'; // shared with the main radar page
let lang = 'zh-Hant';
let mofaLevels = null; // warnings.json "levels"
let cdcLevels = null;  // alerts.json "levels"
let diseases = null;   // alerts.json "diseases"

export function initLang() {
  return setLang(storageGet(LANG_KEY) === 'en' ? 'en' : 'zh-Hant', false);
}
export function setLang(l, persist = true) {
  lang = l === 'en' ? 'en' : 'zh-Hant';
  document.documentElement.lang = lang;
  document.title = t('doc_title');
  if (persist) storageSet(LANG_KEY, lang);
  return lang;
}
export const getLang = () => lang;
export const isEn = () => lang === 'en';

export function t(key, params = {}) {
  const v = DICTS[lang][key] ?? DICTS['zh-Hant'][key];
  if (v == null) return key;
  if (typeof v === 'function') return v(params);
  return String(v).replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ''));
}

/** Apply [data-i18n] text and [data-i18n-attr="attr:key;attr:key"] attributes. */
export function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.dataset.i18nAttr.split(';').forEach((pair) => {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
}

export function bindLevels(warnings, alerts) {
  mofaLevels = warnings?.levels || null;
  cdcLevels = alerts?.levels || null;
  diseases = alerts?.diseases || null;
}

/** "YYYY-MM-DD HH:mm" in Asia/Taipei for an ISO timestamp; '' when missing/invalid. */
export function fmtStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Calendar date YYYY-MM-DD, validated (data dates are shown verbatim: unambiguous in both languages). */
export function fmtDay(s) {
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(s || ''));
  return m ? m[0] : '';
}

// ---- names ----
export const nameOf = (d) => (lang === 'en' ? d.nameEn : d.nameZh);
export const altNameOf = (d) => (lang === 'en' ? d.nameZh : d.nameEn);

export function diseaseName(zhName) {
  const d = diseases?.[zhName];
  if (!d) return clean(zhName);
  return clean(lang === 'en' ? d.en || d.zh : d.zh || d.en);
}

export function regionName(key, warnings) {
  if (key === 'Other') return t('region_Other');
  const r = warnings?.regions?.[key];
  if (r) return lang === 'en' ? r.en || r.zh : r.zh || r.en;
  return key;
}

// ---- MOFA / MAC levels (0..4; null = not listed / no nationwide level) ----
export function mofaFull(lv, source = 'mofa') {
  if (lv == null) return t('mofa_nolist_full');
  if (source === 'mac' && lv >= 1) return t(`mac_full_${lv}`);
  const L = mofaLevels?.[lv];
  return (L && (lang === 'en' ? L.en : L.zh)) || t(`mofa_full_${lv}`);
}
export function mofaShort(lv) {
  if (lv == null) return t('mofa_nolist');
  const L = mofaLevels?.[lv];
  return (L && (lang === 'en' ? L.short_en : L.short_zh)) || t(`mofa_short_${lv}`);
}

// ---- Taiwan CDC levels (0..3) ----
export function cdcFull(lv) {
  if (!lv) return t('cdc_full_0');
  const L = cdcLevels?.[lv];
  return (L && (lang === 'en' ? L.en : L.zh)) || t(`cdc_full_${lv}`);
}
export const cdcShort = (lv) => t(`cdc_short_${lv || 0}`);
export function cdcInstruction(lv) {
  if (!lv) return '';
  const L = cdcLevels?.[lv];
  return (L && (lang === 'en' ? L.instruction_en : L.instruction_zh)) || t(`cdc_instruction_${lv}`);
}
