// Drag a docked overlay (the country panel) off its dock: grab one of its handles and it floats where it is dropped,
// resizable from its corner; position and size are remembered per orientation (landscape / portrait). A dock button
// puts it back. Phones (≤760 px) keep the bottom sheet. Same behaviour as the arrivals board's own title-bar drag.
import { storageGet, storageSet, clamp, debounce } from './util.js';

const NO_DRAG = 'button, a, input, select, textarea, label, summary, [role="switch"], [contenteditable]';
const phone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches;
const orient = () => (window.innerHeight > window.innerWidth ? 'portrait' : 'landscape');

/**
 * root: the overlay; handles: selectors inside it that start a drag; key: localStorage key;
 * dockBtn: shown while floating, docks it again; onChange(floating): re-layout hook.
 */
export function makeFloatable({ root, handles, key, dockBtn, onChange, minW = 320, minH = 240, sized = true }) {
  let pos = {};
  try { pos = JSON.parse(storageGet(key) || '{}') || {}; } catch { pos = {}; }
  const save = () => storageSet(key, JSON.stringify(pos));
  const floating = () => !phone() && !!pos[orient()];

  function apply() {
    const fl = floating();
    root.classList.toggle('is-floating', fl);
    document.body.classList.toggle(`${root.id}-floating`, fl);
    if (dockBtn) dockBtn.hidden = !fl;
    if (!fl) { root.style.left = root.style.top = root.style.width = root.style.height = ''; return; }
    const p = pos[orient()];
    if (!sized) { // keeps its natural size (a toolbar-like bar): only the position is set
      root.style.left = `${clamp(p.x, 8, window.innerWidth - (root.offsetWidth || 200) - 8)}px`;
      root.style.top = `${clamp(p.y, 8, window.innerHeight - (root.offsetHeight || 40) - 8)}px`;
      return;
    }
    const w = clamp(p.w || root.offsetWidth || 460, minW, window.innerWidth - 16);
    const top = clamp(p.y, 8, window.innerHeight - minH - 8);
    const h = clamp(p.h || root.offsetHeight || 600, minH, window.innerHeight - top - 8); // never past the bottom edge
    root.style.width = `${w}px`;
    root.style.height = `${h}px`;
    root.style.left = `${clamp(p.x, 8, window.innerWidth - w - 8)}px`;
    root.style.top = `${top}px`;
  }

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || phone() || !e.target.closest(handles) || e.target.closest(NO_DRAG)) return;
    const r = root.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const m = orient();
    const wasDocked = !pos[m];
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return; // a click, not a drag
      if (!moved) { moved = true; root.setPointerCapture(e.pointerId); document.body.classList.add('is-dragging'); }
      pos[m] = sized ? { ...(pos[m] || {}), x: ev.clientX - dx, y: ev.clientY - dy, w: pos[m]?.w || r.width, h: pos[m]?.h || r.height }
        : { x: ev.clientX - dx, y: ev.clientY - dy };
      apply();
    };
    // on the window, not the overlay: a small overlay (the weather day bar) loses the pointer on the first move
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-dragging');
      if (!moved) return;
      save();
      if (wasDocked) onChange?.(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  dockBtn?.addEventListener('click', () => {
    delete pos[orient()];
    save();
    apply();
    onChange?.(false);
  });

  // the corner handle (CSS resize) changes the size: remember it
  if (sized && 'ResizeObserver' in window) {
    const remember = debounce(() => {
      const m = orient();
      if (!floating() || root.hidden) return;
      const r = root.getBoundingClientRect();
      if (!r.width || (Math.abs(r.width - (pos[m].w || 0)) < 2 && Math.abs(r.height - (pos[m].h || 0)) < 2)) return;
      pos[m] = { ...pos[m], w: Math.round(r.width), h: Math.round(r.height) };
      save();
    }, 300);
    new ResizeObserver(remember).observe(root);
  }
  window.addEventListener('resize', debounce(apply, 150));
  apply();
  return { apply, floating };
}
