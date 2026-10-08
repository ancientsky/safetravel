// Floating tooltip that follows the pointer inside the map.
const PAD = 14;
let el;
let raf = 0;
let pos = [0, 0];

export function initTooltip(node) { el = node; }

export function showTip(html, x, y) {
  if (!el) return;
  el.innerHTML = html;
  el.hidden = false;
  moveTip(x, y);
}

export function moveTip(x, y) {
  if (!el || el.hidden) return;
  pos = [x, y];
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = pos[0] + PAD;
    let top = pos[1] + PAD;
    if (left + w > window.innerWidth - 8) left = pos[0] - w - PAD;
    if (top + h > window.innerHeight - 8) top = pos[1] - h - PAD;
    el.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  });
}

export function hideTip() {
  if (el) el.hidden = true;
}
