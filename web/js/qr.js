// QR code as an inline SVG. The generator (vendor/qrcode.js, MIT) is a classic script fetched on first use, so pages
// that never show a code load nothing. Black on white with a quiet zone in both themes: phone cameras need the contrast.
const SRC = 'vendor/qrcode.js';
const NS = 'http://www.w3.org/2000/svg';
let lib = null;

function load() {
  if (!lib) {
    lib = new Promise((resolve, reject) => {
      if (typeof window.qrcode === 'function') { resolve(window.qrcode); return; }
      const s = document.createElement('script');
      s.src = SRC;
      s.onload = () => (typeof window.qrcode === 'function' ? resolve(window.qrcode) : reject(new Error('qrcode.js')));
      s.onerror = () => { lib = null; reject(new Error('qrcode.js')); };
      document.head.append(s);
    });
  }
  return lib;
}

/**
 * <svg> for `text` (error correction M, smallest version that holds it; quiet zone of 4 modules).
 * Rejects when the generator cannot be loaded or the text is too long.
 */
export async function qrSvg(text, { quiet = 4 } = {}) {
  const make = await load();
  const qr = make(0, 'M');
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (!qr.isDark(y, x)) continue;
      let w = 1;
      while (x + w < n && qr.isDark(y, x + w)) w += 1; // one rectangle per run of dark modules
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w - 1;
    }
  }
  const size = n + quiet * 2;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.modules = String(n);
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(size));
  bg.setAttribute('height', String(size));
  bg.setAttribute('fill', '#fff');
  const fg = document.createElementNS(NS, 'path');
  fg.setAttribute('d', d);
  fg.setAttribute('fill', '#000');
  svg.append(bg, fg);
  return svg;
}
