// Text-size button for index.html and trip.html: cycles 小 → 標準 → 大 → 特大 (S → M → L → XL), remembered per browser.
// js/textsize-boot.js applies the stored size before first paint; the stylesheets scale every font with --ts.
import { storageSet } from './util.js';

export const TEXT_SIZES = ['s', 'm', 'l', 'xl'];
const KEY = 'safetravel.textSize';
const current = () => (TEXT_SIZES.includes(document.documentElement.dataset.ts) ? document.documentElement.dataset.ts : 'xl');

/** btn: the header button; t: the page's translate function (keys ts_s … ts_xl, ts_label); onChange: re-layout hook. */
export function bindTextSize(btn, { t, onChange } = {}) {
  if (!btn) return { refresh() {} };
  const val = btn.querySelector('.ts-val');
  function refresh() {
    const v = current();
    if (val) val.textContent = t(`ts_${v}`);
    const label = t('ts_label', { size: t(`ts_${v}`) });
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.dataset.ts = v;
  }
  btn.addEventListener('click', () => {
    const next = TEXT_SIZES[(TEXT_SIZES.indexOf(current()) + 1) % TEXT_SIZES.length];
    document.documentElement.dataset.ts = next;
    storageSet(KEY, next);
    refresh();
    window.dispatchEvent(new Event('resize')); // maps, docked boards and panels re-fit around the new sizes
    onChange?.(next);
  });
  refresh();
  return { refresh };
}
