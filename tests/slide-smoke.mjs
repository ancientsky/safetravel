// SafeTravel TW — slide.html (衛教海報輪播) smoke test (Playwright + Chromium).
//
// Usage:   node tests/slide-smoke.mjs [pageURL]      (default http://localhost:8080/slide.html)
// Env:     SHOTS_DIR      screenshot directory (slide-*.png)   (default ./tests/shots)
//          CHROMIUM_PATH  optional chromium binary instead of the Playwright-managed browser
//          HEADED=1       run with a visible browser window
//
// This script starts nothing. Serve the site first:  python -m http.server -d web 8080
// Exit code: 0 when every check passes, 1 otherwise (a summary is printed).

import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PAGE_URL = new URL(process.argv[2] || 'http://localhost:8080/slide.html').href;
const SITE = new URL('./', PAGE_URL).href;
const SHOTS_DIR = path.resolve(process.env.SHOTS_DIR || path.join('tests', 'shots'));
const MANIFEST = JSON.parse(readFileSync(new URL('../web/slides/slides.json', import.meta.url), 'utf8'));
// + posters dropped in web/slides/auto/ (auto/index.json, python -m pipeline.slides_auto), shown after the manifest's
const AUTO = (() => { try { return JSON.parse(readFileSync(new URL('../web/slides/auto/index.json', import.meta.url), 'utf8')).slides || []; } catch { return []; } })();
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
const ACTIVE = [...MANIFEST.slides.filter((s) => s.active !== false),
  ...AUTO.filter((s) => (!s.from || s.from <= TODAY) && (!s.until || s.until >= TODAY))].map((s) => s.id);
const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };

const results = [];
const consoleErrors = [];
const url = (q = {}) => `${PAGE_URL}${PAGE_URL.includes('?') ? '&' : '?'}${new URLSearchParams(q)}`;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    record(name, false, (err && err.message ? err.message : String(err)).split('\n')[0]);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function newPage(browser, opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 }, reducedMotion: opts.reducedMotion || 'no-preference' });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${page.url()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  if (opts.manifest) {
    await page.route('**/slides/slides.json*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(opts.manifest) }));
  }
  return { context, page };
}
async function load(page, q) {
  const r = await page.goto(url(q), { waitUntil: 'load' });
  assert(r && r.ok(), `HTTP ${r && r.status()}`);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
}
const current = (page) => page.evaluate(() => document.getElementById('stage').dataset.current);
const playlist = (page) => page.evaluate(() => (document.getElementById('stage').dataset.playlist || '').split(',').filter(Boolean));
const waitChange = (page, from, timeout) => page.waitForFunction((f) => document.getElementById('stage').dataset.current !== f, from, { timeout });
const panelVisible = (page) => page.evaluate(() => {
  const c = getComputedStyle(document.getElementById('ctl'));
  return c.visibility === 'visible' && Number(c.opacity) > 0.5;
});

/** Elements of the active slide that stick out of the canvas (decorative layers excluded). */
function overflowProbe() {
  const sl = document.querySelector('.slide.is-active');
  const box = sl.getBoundingClientRect();
  const bad = [];
  for (const el of sl.querySelectorAll('.slide-body *, .brand *')) {
    if (el.closest('.gm-sky, .al-wave, .sy-hills, .rp-dots, svg') && el.tagName.toLowerCase() !== 'svg') continue;
    if (el.closest('.al-map')) continue; // the map is clipped by its panel on purpose
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) {
      bad.push(`${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).split(' ')[0]}`);
    }
  }
  // text blocks that wrap past their own box
  for (const el of sl.querySelectorAll('p, h2, b, li')) {
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible') bad.push(`clip:${el.className}`);
  }
  return { w: box.width, h: box.height, bad };
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: !process.env.HEADED, executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    await run(browser);
  } finally {
    await browser.close();
  }
  finish();
}

async function run(browser) {
  // ------------------------------------------------------------ basics + auto-advance
  {
    const { context, page } = await newPage(browser);
    await check('page loads: playlist = active manifest slides, portrait by default', async () => {
      await load(page, { interval: 3 });
      const title = await page.title();
      assert(title.includes('衛教海報輪播'), `title "${title}"`);
      const ids = await playlist(page);
      assert(ids.length === 6 && ids.join() === ACTIVE.join(), `playlist ${ids.join()}`);
      assert(await page.locator('.slide').count() === 6, 'slide sections');
      const o = await page.evaluate(() => document.documentElement.dataset.orient);
      assert(o === 'portrait', `orient ${o}`);
      const [w, h] = await page.evaluate(() => [document.getElementById('stage').offsetWidth, document.getElementById('stage').offsetHeight]);
      assert(w === 1080 && h === 1920, `canvas ${w}x${h}`);
      const r = await page.evaluate(() => document.getElementById('stage').getBoundingClientRect().toJSON());
      assert(r.left >= -1 && r.top >= -1 && r.right <= 1281 && r.bottom <= 901, `canvas not fitted: ${JSON.stringify(r)}`);
      return `${ids.length} slides, scaled to ${Math.round(r.width)}x${Math.round(r.height)}`;
    });

    await check('auto-advance every ?interval=3 s, progress bar fills', async () => {
      await load(page, { interval: 3, only: 'ebola-drc-zh,report-en,report-zh' }); // slides without their own duration
      const a = await current(page);
      const t0 = Date.now();
      await waitChange(page, a, 6000);
      const b = await current(page);
      const t1 = Date.now();
      await waitChange(page, b, 6000);
      const dt = (Date.now() - t1) / 1000;
      assert(dt > 2.4 && dt < 4.2, `interval ${dt.toFixed(2)} s`);
      await page.waitForTimeout(1200); // ~40 % into the next slide
      const sx = await page.evaluate(() => Number(/scaleX\(([\d.]+)\)/.exec(document.querySelector('.progress i').style.transform)?.[1]));
      assert(sx > 0.15 && sx < 0.85, `progress ${sx}`);
      await load(page, { interval: 3 });
      return `${a} → ${b} → … every ${dt.toFixed(1)} s (first after ${((t1 - t0) / 1000).toFixed(1)} s)`;
    });

    await check('←/→ keys step through the slides, Space pauses', async () => {
      await page.keyboard.press('Space');
      assert(await page.evaluate(() => document.body.classList.contains('paused')), 'not paused');
      const ids = await playlist(page);
      const a = await current(page);
      await page.keyboard.press('ArrowRight');
      const b = await current(page);
      assert(b === ids[(ids.indexOf(a) + 1) % ids.length], `next ${a} → ${b}`);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      const c = await current(page);
      assert(c === ids[(ids.indexOf(a) - 1 + ids.length) % ids.length], `prev → ${c}`);
      await page.waitForTimeout(3600);
      assert(await current(page) === c, 'advanced while paused');
      await page.keyboard.press('Space');
      return `${a} → ${b} → ${c}`;
    });

    await check('per-slide duration overrides the interval (healthy-travel: 10 s)', async () => {
      await load(page, { interval: 3, slide: 'healthy-travel' });
      assert(await current(page) === 'healthy-travel', 'did not start at ?slide=');
      const d = await page.evaluate(() => document.getElementById('stage').dataset.duration);
      assert(d === '10', `duration ${d}`);
      await page.waitForTimeout(4200);
      assert(await current(page) === 'healthy-travel', 'advanced after the 3 s interval');
      return 'still showing after 4.2 s';
    });

    await check('settings panel appears on mouse move and hides after 3 s idle', async () => {
      assert(!(await panelVisible(page)), 'visible before any input');
      assert(await page.evaluate(() => document.body.classList.contains('idle')), 'cursor not hidden at start');
      await page.mouse.move(300, 300);
      await page.mouse.move(320, 340);
      await page.waitForTimeout(400);
      assert(await panelVisible(page), 'not shown on mouse move');
      assert(!(await page.evaluate(() => document.body.classList.contains('idle'))), 'cursor still hidden');
      await page.screenshot({ path: path.join(SHOTS_DIR, 'slide-settings.png') });
      await page.waitForTimeout(3700);
      assert(!(await panelVisible(page)), 'still visible after 3.7 s idle');
      assert(await page.evaluate(() => document.body.classList.contains('idle')), 'cursor not hidden after idle');
      await page.keyboard.press('s');
      await page.waitForTimeout(300);
      assert(await panelVisible(page), 'S key did not open the panel');
      await page.waitForTimeout(3500);
      assert(await panelVisible(page), 'pinned panel (S) auto-hid');
      await page.keyboard.press('Escape');
      return 'shown, auto-hidden, S pins';
    });

    await check('interval setting persists in localStorage; ?interval= overrides it', async () => {
      await load(page, {});
      await page.keyboard.press('s');
      const input = page.locator('[data-testid="interval"]');
      await input.fill('7');
      await input.press('Enter');
      await input.blur();
      await load(page, {});
      assert(await input.inputValue() === '7', `after reload ${await input.inputValue()}`);
      const st = await page.evaluate(() => localStorage.getItem('safetravel.slide.interval'));
      assert(st === '7', `stored ${st}`);
      const d = await page.evaluate(() => document.getElementById('stage').dataset.duration);
      assert(d === '7', `duration ${d}`);
      await load(page, { interval: 9 });
      assert(await input.inputValue() === '9', 'URL did not override');
      await load(page, { interval: 99 });
      assert(await input.inputValue() === '60', 'not clamped to 60');
      await page.evaluate(() => localStorage.removeItem('safetravel.slide.interval'));
      return 'stored 7, URL 9, clamped 60';
    });

    await check('per-screen hide (localStorage) removes a slide from the playlist', async () => {
      await load(page, {});
      await page.keyboard.press('s');
      await page.locator('[data-testid="slide-list"] input[data-id="report-en"]').uncheck();
      let ids = await playlist(page);
      assert(!ids.includes('report-en') && ids.length === 5, `playlist ${ids}`);
      await load(page, {});
      ids = await playlist(page);
      assert(!ids.includes('report-en'), 'not persisted');
      await load(page, { only: 'report-en,no-germs' });
      ids = await playlist(page);
      assert(ids.join() === 'report-en,no-germs', `?only= ${ids}`);
      await page.evaluate(() => localStorage.removeItem('safetravel.slide.hidden'));
      return 'hidden, persisted, ?only= overrides';
    });

    await check('downloads: PNG links from the export index + Print/PDF hint (or "not exported yet")', async () => {
      await load(page, {});
      await page.waitForFunction(() => document.querySelector('[data-testid="downloads"]').children.length > 0);
      const pngs = await page.locator('[data-testid="downloads"] a[href$=".png"]').count();
      const hint = await page.locator('[data-testid="dl-pdf-hint"]').count();
      const none = await page.locator('[data-testid="dl-none"]').count();
      assert((pngs === MANIFEST.slides.filter((x) => x.active !== false).length * 2 && hint === 1) || none === 1,
        `png links ${pngs}, pdf hint ${hint}, none ${none}`);
      return none ? 'not exported yet' : `${pngs} PNG links + Print/PDF hint`;
    });
    await context.close();
  }

  // ------------------------------------------------------------ manifest rules (routed slides.json)
  {
    const m = structuredClone(MANIFEST);
    m.slides.find((s) => s.id === 'healthy-travel').active = false;
    m.slides.find((s) => s.id === 'report-en').until = '2020-01-31';
    m.slides.find((s) => s.id === 'report-zh').from = '2099-01-01';
    m.slides.find((s) => s.id === 'ebola-drc-zh').duration = 4;
    const { context, page } = await newPage(browser, { manifest: m });
    await check('inactive, expired (until) and not-yet-started (from) slides are skipped', async () => {
      await load(page, { interval: 3 });
      const ids = await playlist(page);
      assert(ids.join() === 'ebola-drc-zh,ebola-drc-en,no-germs', `playlist ${ids}`);
      const st = await page.$$eval('[data-testid="slide-list"] li', (els) => els.map((e) => `${e.dataset.id}:${e.dataset.status}`));
      assert(st.includes('healthy-travel:inactive') && st.includes('report-en:expired') && st.includes('report-zh:scheduled'), st.join());
      return ids.join(' · ');
    });
    await check('routed per-slide duration (4 s) is respected', async () => {
      await load(page, { interval: 3 });
      const a = await current(page);
      assert(a === 'ebola-drc-zh', a);
      const t = Date.now();
      await waitChange(page, a, 7000);
      const dt = (Date.now() - t) / 1000;
      assert(dt > 3.4 && dt < 5.2, `${dt.toFixed(2)} s`);
      return `${dt.toFixed(1)} s`;
    });
    await check('live refresh: a changed slides.json applies without reload', async () => {
      const m2 = structuredClone(m);
      m2.slides.find((s) => s.id === 'no-germs').active = false;
      await page.unroute('**/slides/slides.json*');
      await page.route('**/slides/slides.json*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(m2) }));
      await page.evaluate(() => { window.__marker = 1; document.dispatchEvent(new Event('slides:refresh')); });
      await page.waitForFunction(() => !document.getElementById('stage').dataset.playlist.includes('no-germs'), null, { timeout: 4000 });
      assert(await page.evaluate(() => window.__marker === 1), 'page reloaded');
      return (await playlist(page)).join(' · ');
    });
    await context.close();
  }

  // ------------------------------------------------------------ auto-publish folder (web/slides/auto/ -> auto/index.json)
  {
    const EXPORT_DIR = new URL('../web/slides/export/', import.meta.url);
    const shot = (f) => readFileSync(new URL(f, EXPORT_DIR));
    const autoDoc = { version: 1, folder: 'web/slides/auto/', slides: [
      { id: 'auto-test00001', template: 'image', auto: true, active: true, alt: '測試海報 auto', file: '01_測試_直式.png',
        src: 'slides/auto/01_%E6%B8%AC%E8%A9%A6_p.png', src_landscape: 'slides/auto/01_%E6%B8%AC%E8%A9%A6_l.png', duration: 4 },
      { id: 'auto-test00002', template: 'image', auto: true, active: true, alt: 'expired', file: 'old.png',
        src: 'slides/auto/old.png', until: '2020-01-01' },
    ] };
    const { context, page } = await newPage(browser, { viewport: PORTRAIT });
    await page.route('**/slides/auto/index.json*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(autoDoc) }));
    await page.route('**/slides/auto/*_p.png', (route) => route.fulfill({ contentType: 'image/png', body: shot('report-zh-portrait.png') }));
    await page.route('**/slides/auto/*_l.png', (route) => route.fulfill({ contentType: 'image/png', body: shot('report-zh-landscape.png') }));
    await check('auto folder: posters join the playlist after slides.json, expired ones stay out', async () => {
      await load(page, { play: 0 });
      const ids = await playlist(page);
      assert(ids.at(-1) === 'auto-test00001' && !ids.includes('auto-test00002'), ids.join(','));
      const label = await page.locator('[data-testid="slide-list"] li[data-id="auto-test00001"] .mono').textContent();
      assert(label.includes('測試海報'), `list label ${label}`);
      return `${ids.length} slides, last = auto-test00001`;
    });
    await check('auto folder: the 直式 file on portrait screens, the 橫式 file on landscape screens', async () => {
      const visible = () => page.evaluate(() => {
        const img = [...document.querySelectorAll('.slide.is-active .im-poster')].find((x) => x.getBoundingClientRect().width > 0);
        return img ? decodeURIComponent(img.currentSrc.split('/').pop()) : '';
      });
      await load(page, { only: 'auto-test00001', still: 1 });
      const p = await visible();
      await page.setViewportSize(LANDSCAPE);
      await load(page, { only: 'auto-test00001', still: 1, orient: 'landscape' });
      const l = await visible();
      assert(p === '01_測試_p.png' && l === '01_測試_l.png', `${p} / ${l}`);
      return `${p} / ${l}`;
    });
    await context.close();
  }

  // ------------------------------------------------------------ self-reload when the site code changes (version.json)
  {
    const { context, page } = await newPage(browser, { viewport: PORTRAIT });
    let code = 'aaaa1111';
    await page.route('**/version.json*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code }) }));
    await check('new site code: the carousel reloads itself at the next poster change', async () => {
      await load(page, { interval: 4, refreshEvery: 1 });
      await page.evaluate(() => { window.__marker = 1; });
      await page.waitForTimeout(2000);
      assert(await page.evaluate(() => !document.documentElement.dataset.reloadPending), 'pending without a change');
      code = 'bbbb2222';
      await page.waitForFunction(() => document.documentElement.dataset.reloadPending === 'code', null, { timeout: 6000 });
      const from = await current(page);
      const reloaded = page.waitForEvent('load', { timeout: 8000 });
      await reloaded;
      await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
      const marker = await page.evaluate(() => window.__marker);
      assert(marker === undefined, 'no reload');
      await page.waitForTimeout(2500); // the new code is the new baseline: no reload loop
      assert(await page.evaluate(() => !document.documentElement.dataset.reloadPending), 'reload loop');
      return `pending while showing ${from}, reloaded at the poster change`;
    });
    await context.close();
  }

  // ------------------------------------------------------------ orientations: fit + layout per orientation
  {
    const pos = {};
    const bars = {};
    for (const [orient, vp] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]]) {
      const { context, page } = await newPage(browser, { viewport: vp });
      await check(`${orient}: every slide fits ${vp.width}x${vp.height} without overflow`, async () => {
        const issues = [];
        for (const id of ACTIVE) {
          await load(page, { orient, only: id, still: 1 });
          const r = await page.evaluate(overflowProbe);
          assert(Math.round(r.w) === vp.width && Math.round(r.h) === vp.height, `${id}: canvas ${r.w}x${r.h}`);
          if (r.bad.length) issues.push(`${id}: ${[...new Set(r.bad)].slice(0, 4).join(', ')}`);
          await page.screenshot({ path: path.join(SHOTS_DIR, `slide-${id}-${orient}.png`) });
          bars[`${orient}:${id}`] = await page.evaluate(() => {
            const f = document.querySelector('.slide.is-active .brand');
            const r2 = f.getBoundingClientRect();
            return [Math.round(r2.top), Math.round(r2.height), f.innerText.replace(/\s+/g, ' ').trim()];
          });
          pos[`${orient}:${id}`] = await page.evaluate(() => {
            const k = document.querySelector('.slide.is-active h2, .slide.is-active .al-disease');
            const r2 = k.getBoundingClientRect();
            return [Math.round(r2.left), Math.round(r2.top), Math.round(r2.width)];
          });
        }
        assert(!issues.length, issues.join(' | '));
        return `${ACTIVE.length} slides, screenshots slide-*-${orient}.png`;
      });
      await context.close();
    }
    await check('CDC bar is identical on every slide (position, height, text) in each orientation', async () => {
      for (const orient of ['portrait', 'landscape']) {
        const seen = new Set(ACTIVE.map((id) => JSON.stringify(bars[`${orient}:${id}`])));
        assert(seen.size === 1, `${orient}: ${[...seen].join(' ≠ ')}`);
      }
      const [top, height] = bars[`portrait:${ACTIVE[0]}`];
      return `portrait top ${top} h ${height}; landscape h ${bars[`landscape:${ACTIVE[0]}`][1]}`;
    });
    await check('landscape has its own layout (headline positions differ from portrait)', async () => {
      const differ = ACTIVE.filter((id) => JSON.stringify(pos[`portrait:${id}`]) !== JSON.stringify(pos[`landscape:${id}`]));
      assert(differ.length === ACTIVE.length, `same layout for ${ACTIVE.filter((x) => !differ.includes(x))}`);
      return `alert headline portrait ${pos['portrait:ebola-drc-zh']} vs landscape ${pos['landscape:ebola-drc-zh']}`;
    });
    await check('orient=auto picks landscape on a wide screen and portrait on a tall one', async () => {
      const { context, page } = await newPage(browser, { viewport: { width: 1600, height: 900 } });
      await load(page, { orient: 'auto' });
      const a = await page.evaluate(() => document.documentElement.dataset.orient);
      await page.setViewportSize({ width: 800, height: 1400 });
      await page.waitForTimeout(200);
      const b = await page.evaluate(() => document.documentElement.dataset.orient);
      await context.close();
      assert(a === 'landscape' && b === 'portrait', `${a} / ${b}`);
      return `${a} → ${b}`;
    });
    // mid-animation captures (entrance choreography)
    const { context, page } = await newPage(browser, { viewport: PORTRAIT });
    for (const [id, ms] of [['ebola-drc-zh', 450], ['report-en', 700]]) {
      await load(page, { only: id, play: 0 });
      await page.evaluate(() => {
        const s = document.querySelector('.slide.is-active');
        s.classList.remove('is-active'); void s.offsetWidth; s.classList.add('is-active'); s.slideEnter?.(false);
      });
      await page.waitForTimeout(ms);
      await page.screenshot({ path: path.join(SHOTS_DIR, `slide-mid-${id}-${ms}ms.png`) });
    }
    await context.close();
  }

  // ------------------------------------------------------------ print + reduced motion
  {
    const { context, page } = await newPage(browser, { viewport: { width: 1280, height: 900 } });
    await check('print media shows every playlist slide, one per page, final state', async () => {
      await load(page, {});
      await page.emulateMedia({ media: 'print' });
      const r = await page.$$eval('.slide', (els) => els.map((e) => {
        const c = getComputedStyle(e);
        return { vis: c.visibility, op: c.opacity, w: e.offsetWidth, h: e.offsetHeight, br: c.breakAfter, page: c.page };
      }));
      assert(r.length === 6, `${r.length} slides`);
      assert(r.every((x) => x.vis === 'visible' && x.op === '1' && x.w === 1080 && x.h === 1920), JSON.stringify(r[1]));
      assert(r.slice(0, -1).every((x) => x.br === 'page') && r[0].page === 'portrait', `break ${r[0].br} page ${r[0].page}`);
      const anim = await page.$eval('.slide .fx-slam', (e) => getComputedStyle(e).animationName);
      assert(anim === 'none', `animation ${anim}`);
      const hidden = await page.$eval('.chrome', (e) => getComputedStyle(e).display);
      assert(hidden === 'none', 'progress/dots printed');
      await page.emulateMedia({ media: 'screen' });
      return '6 pages @ 1080x1920';
    });
    await context.close();
    const rm = await newPage(browser, { reducedMotion: 'reduce' });
    await check('prefers-reduced-motion: no entrance movement, slides still rotate', async () => {
      await load(rm.page, { interval: 3 });
      const anim = await rm.page.$eval('.slide.is-active .fx-slam, .slide.is-active .fx-pop', (e) => getComputedStyle(e).animationName);
      assert(anim === 'none', `animation ${anim}`);
      const a = await current(rm.page);
      await waitChange(rm.page, a, 6000);
      return `${a} → ${await current(rm.page)}`;
    });
    await rm.context.close();
  }

  // ------------------------------------------------------------ entry points on the other pages
  {
    const { context, page } = await newPage(browser, { viewport: { width: 1600, height: 900 } });
    await check('main page: menu entry, arrivals-board button and footer link to slide.html', async () => {
      await page.goto(new URL('index.html', SITE).href, { waitUntil: 'load' });
      await page.waitForFunction(() => !document.documentElement.classList.contains('i18n-pending') && document.querySelector('[data-testid="menu-slides"]'));
      for (const sel of ['[data-testid="menu-slides"]', '[data-testid="arrivals-slides-link"]', '[data-testid="footer-slides-link"]']) {
        const href = await page.getAttribute(sel, 'href');
        assert(href === 'slide.html', `${sel} → ${href}`);
      }
      assert(await page.locator('[data-testid="menu-toggle"]').isVisible(), 'menu button hidden at 1600');
      return '3 links';
    });
    await check('main header fits on one row with the menu button (1181/1280/1441/1600/390 px; zh + en)', async () => {
      const out = [];
      for (const lang of ['zh-Hant', 'en']) {
        await page.evaluate((l) => localStorage.setItem('safetravel.lang', l), lang);
        for (const w of [1181, 1280, 1441, 1600, 390]) {
          await page.setViewportSize({ width: w, height: 900 });
          await page.goto(new URL('index.html', SITE).href, { waitUntil: 'load' });
          await page.waitForFunction(() => !document.documentElement.classList.contains('i18n-pending'));
          await page.waitForTimeout(150);
          const r = await page.evaluate(() => {
            const vis = (e) => e.offsetParent !== null && getComputedStyle(e).display !== 'none';
            const btns = [...document.querySelectorAll('.hud-right .toggles > *')].filter(vis).map((e) => e.getBoundingClientRect());
            const right = document.querySelector('.hud-right').getBoundingClientRect();
            const brand = document.querySelector('.brand').getBoundingClientRect();
            const link = document.querySelector('[data-testid="menu-toggle"]');
            return {
              rows: new Set(btns.map((b) => Math.round(b.top))).size,
              overflow: right.right > innerWidth + 1 || btns.some((b) => b.right > innerWidth + 1),
              overlap: brand.right > right.left + 1 && brand.bottom > right.top,
              linkShown: vis(link),
              topH: Math.round(document.querySelector('.hud-top').getBoundingClientRect().height),
            };
          });
          if (w === 1600 || w === 1181) await page.screenshot({ path: path.join(SHOTS_DIR, `slide-header-${w}-${lang}.png`), clip: { x: 0, y: 0, width: w, height: 160 } });
          const bad = r.rows !== 1 || r.overflow || r.overlap || !r.linkShown;
          if (bad) out.push(`${lang}@${w}: ${JSON.stringify(r)}`);
        }
      }
      await page.evaluate(() => localStorage.removeItem('safetravel.lang'));
      assert(!out.length, out.join(' | '));
      return '10 layouts ok';
    });
    await check('trip page links to slide.html', async () => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(new URL('trip.html', SITE).href, { waitUntil: 'load' });
      const n = await page.locator('a[href="slide.html"]').count();
      assert(n >= 2, `${n} links`);
      return `${n} links`;
    });
    await context.close();
  }

  await check('no console errors across all pages', async () => {
    assert(consoleErrors.length === 0, `${consoleErrors.length}: ${consoleErrors[0]}`);
    return '0';
  });
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
