// i18n: dictionary lookup, locale-aware formatting, and data-driven name helpers.
import zh from '../i18n/zh-Hant.js';
import en from '../i18n/en.js';
import {
  esc, parseDay, elapsed, clean, levelNum,
} from './util.js';

const DICTS = { 'zh-Hant': zh, en };
export const LANGS = ['zh-Hant', 'en'];
let lang = 'zh-Hant';

export function setLang(l) {
  lang = DICTS[l] ? l : 'zh-Hant';
  document.documentElement.lang = lang;
  document.title = t('doc_title');
  return lang;
}
export const getLang = () => lang;
export const isEn = () => lang === 'en';
export const locale = () => (lang === 'en' ? 'en-GB' : 'zh-Hant-TW');

export function t(key, params = {}) {
  const v = DICTS[lang][key] ?? DICTS['zh-Hant'][key];
  if (v == null) return key;
  if (typeof v === 'function') return v(params);
  return String(v).replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ''));
}

/** Apply [data-i18n] text and [data-i18n-attr="attr:key;attr:key"] attributes. */
export function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.dataset.i18nAttr.split(';').forEach((pair) => {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
}

const nfCache = new Map();
export function fmtNum(n, opts = {}) {
  if (n == null || Number.isNaN(+n)) return '—';
  const k = `${lang}|${JSON.stringify(opts)}`;
  if (!nfCache.has(k)) nfCache.set(k, new Intl.NumberFormat(locale(), opts));
  return nfCache.get(k).format(n);
}

export function fmtDay(dateStr, style = 'medium') {
  const d = parseDay(dateStr);
  if (!d) return dateStr || '—';
  if (style === 'short') return String(dateStr).slice(0, 10); // ISO, unambiguous in both languages
  const opts = style === 'short'
    ? { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }
    : { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat(locale(), opts).format(d);
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '—';
  return new Intl.DateTimeFormat(locale(), {
    timeZone: 'Asia/Taipei', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

export function fmtRelative(iso, now = Date.now()) {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '—';
  const sec = Math.round((+d - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const abs = Math.abs(sec);
  if (abs < 60) return rtf.format(sec, 'second');
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
  return rtf.format(Math.round(sec / 86400), 'day');
}

/** "已 N 個月" / "N months" since a YYYY-MM-DD date. */
export function fmtAge(dateStr) {
  const e = elapsed(dateStr);
  if (!e) return '';
  if (e.days <= 0) return t('age_today');
  if (e.days < 31 || e.months < 1) return t('age_days', { n: e.days });
  if (e.months < 12) return t('age_months', { n: e.months });
  const y = Math.floor(e.months / 12);
  const m = e.months % 12;
  return m && y < 3 ? t('age_years_months', { y, m }) : t('age_years', { y });
}

// ---- data-aware helpers (need the loaded data) ----
let data = {};
export function bindData(d) { data = d; }

export function countryName(iso, which = lang) {
  const a = data.alerts?.countries?.[iso];
  const c = data.countries?.[iso];
  const enName = a?.name_en || c?.en || data.worldNames?.get(iso) || iso;
  const zhName = a?.name_zh || c?.zh || enName;
  return which === 'en' ? enName : zhName;
}
export const countryAltName = (iso) => countryName(iso, lang === 'en' ? 'zh-Hant' : 'en');

export function diseaseName(zhName) {
  const d = data.alerts?.diseases?.[zhName];
  if (!d) return clean(zhName);
  return clean(lang === 'en' ? d.en || d.zh : d.zh || d.en);
}

export function levelShort(level) { return t(`level_short_${level || 0}`); }
export function levelFull(level) {
  if (!level) return t('level_0');
  const L = data.alerts?.levels?.[level];
  if (L) return lang === 'en' ? L.en : L.zh;
  return t(`level_full_${level}`);
}
export function levelInstruction(level) {
  if (!level) return '';
  const L = data.alerts?.levels?.[level];
  if (L) return lang === 'en' ? L.instruction_en : L.instruction_zh;
  return t(`instruction_${level}`);
}

export function badge(level, text = levelShort(level), extra = '') {
  return `<span class="badge lvl-${levelNum(level)} ${esc(extra)}"><i aria-hidden="true"></i>${esc(text)}</span>`;
}

/** Pick zh/en field of an epidemic item; returns {text, fallback} where fallback marks untranslated zh. */
export function pick(item, base) {
  const zhv = clean(item[`${base}_zh`]);
  if (lang !== 'en') return { text: zhv, fallback: false };
  const env = clean(item[`${base}_en`]);
  return { text: env || zhv, fallback: !env || env === zhv };
}
