// Export every active poster of slide.html as PNG (1080x1920 portrait + 1920x1080 landscape) into
// web/slides/export/, plus web/slides/export/index.json (slide.html offers them as downloads).
// The PNGs are deterministic, so an unchanged poster never produces a new commit; index.json keeps its
// generated_at unless the PNG set or the manifest changed. PDFs embed a creation time (every run differs) and are
// large, so they are only written on request with --pdf-dir DIR (never into the repo); on the page, Print / Save as
// PDF gives the same pages.
//
// Usage:   node scripts/export-slides.mjs [siteURL] [--pdf-dir DIR]     (default http://localhost:8150/)
// Env:     CHROMIUM_PATH  optional chromium binary (local dev: /opt/pw-browsers/chromium); CI uses Playwright's own
//
// Serve web/ first:  python -m http.server -d web 8150
// Rendering uses slide.html?still=1 (animations at their final state, no controls) and, for the PDFs, print media
// (the same @page rules a browser's "Print / Save as PDF" uses). Run by .github/workflows/slides.yml.
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const pdfAt = args.indexOf('--pdf-dir');
const PDF_DIR = pdfAt >= 0 ? path.resolve(args.splice(pdfAt, 2)[1] || '') : null;
const BASE = new URL(args[0] || process.env.SLIDES_URL || 'http://localhost:8150/');
const OUT = path.resolve('web/slides/export');
const MANIFEST = path.resolve('web/slides/slides.json');
const DIMS = { portrait: [1080, 1920], landscape: [1920, 1080] };
const page = (q) => new URL(`slide.html?${new URLSearchParams({ still: '1', play: '0', ...q })}`, BASE).href;

async function open(context, url) {
  const p = await context.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  // a missing slides/export/* (this script's own output, e.g. index.json on the very first run) is expected
  p.on('console', (m) => { if (m.type() === 'error' && !/\/slides\/export\//.test(m.location()?.url || '')) errors.push(m.text()); });
  const r = await p.goto(url, { waitUntil: 'load' });
  if (!r || !r.ok()) throw new Error(`${url}: HTTP ${r && r.status()}`);
  await p.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 20000 });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(150);
  if (errors.length) throw new Error(`${url}: ${errors[0]}`);
  return p;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const manifestText = readFileSync(MANIFEST, 'utf8');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const written = new Set(['index.json']);
  const index = {
    version: 1,
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    manifest_sha256: createHash('sha256').update(manifestText, 'utf8').digest('hex'),
    slides: [],
  };
  try {
    const rows = new Map();
    for (const [orient, [width, height]] of Object.entries(DIMS)) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      // the playlist as this site would show it today (active / from / until)
      const probe = await open(context, page({ orient }));
      const ids = (await probe.evaluate(() => document.getElementById('stage').dataset.playlist || '')).split(',').filter(Boolean);
      await probe.close();
      if (!ids.length) throw new Error('no active slides in web/slides/slides.json');
      for (const id of ids) {
        const p = await open(context, page({ orient, only: id }));
        const file = `${id}-${orient}.png`;
        await p.screenshot({ path: path.join(OUT, file), clip: { x: 0, y: 0, width, height } });
        await p.close();
        written.add(file);
        if (!rows.has(id)) rows.set(id, { id });
        rows.get(id)[orient] = file;
        console.log(`png  ${file}`);
      }
      if (PDF_DIR) {
        mkdirSync(PDF_DIR, { recursive: true });
        const p = await open(context, page({ orient }));
        await p.emulateMedia({ media: 'print' });
        const pdf = path.join(PDF_DIR, `slides-${orient}.pdf`);
        await p.pdf({ path: pdf, printBackground: true, preferCSSPageSize: true });
        await p.close();
        console.log(`pdf  ${pdf} (${ids.length} pages)`);
      }
      await context.close();
    }
    index.slides = [...rows.values()];
  } finally {
    await browser.close();
  }
  for (const f of readdirSync(OUT)) {
    if (!written.has(f) && /\.(png|pdf)$/.test(f)) { rmSync(path.join(OUT, f)); console.log(`rm   ${f} (no longer active)`); }
  }
  // keep the previous generated_at when nothing changed, so a re-run commits nothing
  try {
    const prev = JSON.parse(readFileSync(path.join(OUT, 'index.json'), 'utf8'));
    const same = (a) => JSON.stringify({ ...a, generated_at: '' });
    if (prev && same(prev) === same(index)) index.generated_at = prev.generated_at;
  } catch { /* first export */ }
  writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`index.json: ${index.slides.length} slides`);
}

main().catch((e) => { console.error(e); process.exit(1); });
