// trip.html DOM helpers: element builder (text only, never HTML), level chips and safe external links.
import { safeHref } from './trip-data.js';
import { mofaShort, mofaFull, cdcShort, cdcFull } from './trip-i18n.js';

/** h('a', {class, href, text, onclick, dataset}, ...children) — children are Nodes or text. */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false || kid === '') continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

/** External link to a vetted https government page, or plain text when the URL fails validation. */
export function extLink(url, text, cls = 'ext') {
  const href = safeHref(url);
  if (!href) return h('span', { class: `${cls} ext-off`, text });
  return h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer', text });
}

/** MOFA / MAC level chip; lv null → "not listed". `full` uses the long level name. */
export function mofaChip(lv, { full = false, source = 'mofa', size = '', text } = {}) {
  const k = lv == null ? 'n' : lv;
  return h('span', { class: `chip mchip m-${k}${size ? ` chip-${size}` : ''}` },
    h('b', { class: 'chip-n', 'aria-hidden': lv == null ? 'true' : null, text: lv == null ? '–' : String(lv) }),
    h('span', { class: 'chip-t', text: text ?? (full ? mofaFull(lv, source) : mofaShort(lv)) }));
}

/** Taiwan CDC level chip (0..3). */
export function cdcChip(lv, { full = false, size = '', text } = {}) {
  return h('span', { class: `chip cchip c-${lv || 0}${size ? ` chip-${size}` : ''}` },
    h('b', { class: 'chip-n', 'aria-hidden': 'true', text: String(lv || 0) }),
    h('span', { class: 'chip-t', text: text ?? (full ? cdcFull(lv) : cdcShort(lv)) }));
}
