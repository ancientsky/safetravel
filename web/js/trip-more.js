// trip.html: long lists start short, with one "show all (n)" button under them — `limit` items on a phone
// (up to 760 px wide), `wide` items on wider screens. The caller keeps rendering (and filtering) every item; this
// only marks the items after the first few with .is-more, which trip.css hides on screen (print keeps every item).
import { h } from './trip-dom.js';
import { t } from './trip-i18n.js';

/**
 * @param {object} o
 * @param {Element} o.host    element that contains the items (gets .clip, and .is-all while expanded)
 * @param {Element} o.after   the button is inserted after this element
 * @param {number}  o.limit   items shown before the button on a phone
 * @param {number}  o.wide    items shown before the button on wider screens
 * @param {string}  o.testid
 */
export function createMore({ host, after, limit: phone, wide = phone, testid }) {
  let all = false;
  let total = 0;
  let last = [];
  const mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : null;
  let limit = mq && !mq.matches ? wide : phone;
  const btn = h('button', {
    type: 'button', class: 'btn more-btn', 'data-testid': testid, 'aria-expanded': 'false', 'aria-controls': host.id || null, hidden: true,
  });
  after.after(btn);
  host.classList.add('clip');

  function paint() {
    host.classList.toggle('is-all', all);
    btn.hidden = total <= limit;
    btn.setAttribute('aria-expanded', String(all));
    btn.textContent = all ? t('more_less') : t('more_all', { n: total });
  }
  btn.addEventListener('click', () => {
    all = !all;
    paint();
    // collapsed: the page just got much shorter, so go straight back to the start of the list
    if (!all) host.scrollIntoView({ block: 'start', behavior: 'auto' });
  });

  function update(items) {
    last = items;
    total = items.length;
    items.forEach((el, i) => el.classList.toggle('is-more', i >= limit));
    paint();
  }
  // phone ↔ wider (rotation, window resize): re-mark with the other limit
  const onWidth = () => { limit = mq.matches ? phone : wide; update(last); };
  if (mq?.addEventListener) mq.addEventListener('change', onWidth); else mq?.addListener?.(onWidth);

  return {
    /** `items`: the elements that pass the current filter, in display order. */
    update,
    /** Expand when `el` is one of the items after the limit (before scrolling to it or focusing it). */
    reveal(el) {
      if (all || !el || !el.classList.contains('is-more')) return;
      all = true;
      paint();
    },
  };
}
