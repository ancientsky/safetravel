// trip.html on phones: long lists start short, with one "show all (n)" button under them.
// The caller keeps rendering (and filtering) every item; this only marks the items after the first `limit`
// with .is-more. trip.css hides those — and shows the button — on screens up to 760 px wide, so wider
// screens and print are untouched.
import { h } from './trip-dom.js';
import { t } from './trip-i18n.js';

/**
 * @param {object} o
 * @param {Element} o.host    element that contains the items (gets .clip, and .is-all while expanded)
 * @param {Element} o.after   the button is inserted after this element
 * @param {number}  o.limit   items shown before the button
 * @param {string}  o.testid
 */
export function createMore({ host, after, limit, testid }) {
  let all = false;
  let total = 0;
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

  return {
    /** `items`: the elements that pass the current filter, in display order. */
    update(items) {
      total = items.length;
      items.forEach((el, i) => el.classList.toggle('is-more', i >= limit));
      paint();
    },
    /** Expand when `el` is one of the items after the limit (before scrolling to it or focusing it). */
    reveal(el) {
      if (all || !el || !el.classList.contains('is-more')) return;
      all = true;
      paint();
    },
  };
}
