// SafeTravel TW smoke test (Playwright + Chromium).
//
// Usage:   node tests/smoke.mjs [baseURL]        (default http://localhost:8080/)
// Env:     SHOTS_DIR      screenshot directory            (default ./tests/shots)
//          CHROMIUM_PATH  optional chromium/headless_shell binary to use instead of the
//                         Playwright-managed browser (e.g. when `playwright install` is unavailable)
//          HEADED=1       run with a visible browser window
//
// This script starts nothing. Serve the site first:  python -m http.server -d web 8080
// Exit code: 0 when every check passes, 1 otherwise (a summary is printed).

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE_URL = new URL(process.argv[2] || 'http://localhost:8080/').href;
const SHOTS_DIR = path.resolve(process.env.SHOTS_DIR || path.join('tests', 'shots'));
const MAP_SELECTOR = '[data-testid="map"] path.country';
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const PANEL = '[data-testid="country-panel"]';
const LANG_TOGGLE = '[data-testid="lang-toggle"]';
const THEME_TOGGLE = '[data-testid="theme-toggle"]';
const FLIGHTS = '[data-testid="flights-layer"]';
const SPOTLIGHT = '[data-testid="spotlight"]';
const TARGET_ISO = 'CD';
const PANEL_TEXT_RE = /伊波拉|Ebola/;

const results = [];      // { name, ok, detail }
const warnings = [];     // non-fatal observations
const consoleErrors = []; // error-level console messages and uncaught page errors

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// Runs one named check. Errors are recorded and the remaining checks still run.
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
    return true;
  } catch (err) {
    record(name, false, (err && err.message ? err.message : String(err)).split('\n')[0]);
    return false;
  }
}

async function shot(page, name) {
  const file = path.join(SHOTS_DIR, name);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function dataState(page) {
  return page.evaluate(() => ({
    theme: document.documentElement.dataset.theme || '',
    lang: document.documentElement.lang || '',
  }));
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: !process.env.HEADED,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  try {
    await run(browser);
  } finally {
    await browser.close().catch(() => {});
  }
  finish();
}

async function run(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(`console.error: ${msg.text()} @ ${msg.location()?.url || '?'}`);
    }
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  // the weather overlay is off by default: nothing weather-related may be fetched until it is switched on
  const wxRequests = [];
  page.on('request', (req) => { if (/weather\.json|js\/weather\.js|wx-shared\.js/.test(req.url())) wxRequests.push(req.url()); });

  console.log(`SafeTravel TW smoke test → ${BASE_URL}`);
  console.log(`Screenshots → ${SHOTS_DIR}\n`);

  // 0. Load the page
  const loaded = await check('page loads', async () => {
    const resp = await page.goto(BASE_URL, { waitUntil: 'load', timeout: 30000 });
    if (!resp) throw new Error('no response');
    if (!resp.ok()) throw new Error(`HTTP ${resp.status()} — is the server running at ${BASE_URL}?`);
    return `HTTP ${resp.status()}`;
  });
  if (!loaded) return;

  // 1. Map renders with > 150 countries
  await check('map has > 150 country paths', async () => {
    await page.waitForFunction(
      (sel) => document.querySelectorAll(sel).length > 150,
      MAP_SELECTOR,
      { timeout: 30000, polling: 250 },
    );
    const n = await page.locator(MAP_SELECTOR).count();
    return `${n} paths`;
  });

  const initial = await dataState(page);
  await check('initial theme/lang recorded', async () => `theme=${initial.theme || '(unset)'} lang=${initial.lang || '(unset)'}`);
  await shot(page, `01-initial-${initial.theme || 'default'}-${initial.lang || 'default'}.png`);

  // 2. Open the country panel for CD (click, fall back to the debug API)
  const openedOk = await check(`open country panel for ${TARGET_ISO}`, async () => {
    const pathLoc = page.locator(`path.country[data-iso="${TARGET_ISO}"]`);
    if ((await pathLoc.count()) > 0) {
      try {
        await pathLoc.first().click({ timeout: 5000 });
        return 'via click';
      } catch {
        // element covered or off-screen: dispatch a click event directly
        await pathLoc.first().evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        return 'via dispatched click';
      }
    }
    const usedApi = await page.evaluate((iso) => {
      if (window.__safetravel && typeof window.__safetravel.openCountry === 'function') {
        window.__safetravel.openCountry(iso);
        return true;
      }
      return false;
    }, TARGET_ISO);
    if (!usedApi) throw new Error(`no path.country[data-iso="${TARGET_ISO}"] and no window.__safetravel.openCountry`);
    return 'via window.__safetravel.openCountry';
  });

  // 3. Panel visible and mentions Ebola / 伊波拉
  const panelOk = await check(`country panel visible with "伊波拉" or "Ebola"`, async () => {
    const panel = page.locator(PANEL);
    await panel.waitFor({ state: 'visible', timeout: 10000 });
    const text = (await panel.innerText()).trim();
    if (!PANEL_TEXT_RE.test(text)) {
      throw new Error(`panel text has no 伊波拉/Ebola (first 80 chars: ${text.slice(0, 80)})`);
    }
    return `${text.length} chars`;
  });
  if (panelOk) {
    await shot(page, `02-panel-open-${initial.theme || 'default'}-${initial.lang || 'default'}.png`);
  }

  // 4. Language toggle changes the panel text
  await check('lang toggle changes panel text', async () => {
    if (!openedOk) throw new Error('skipped: panel was not opened');
    const panel = page.locator(PANEL);
    const before = (await panel.innerText()).trim();
    const beforeLang = (await dataState(page)).lang;
    await page.locator(LANG_TOGGLE).first().click({ timeout: 5000 });
    await page.waitForFunction(
      ([sel, prev]) => {
        const el = document.querySelector(sel);
        return !!el && el.innerText.trim() !== prev;
      },
      [PANEL, before],
      { timeout: 5000, polling: 100 },
    ).catch(() => {});
    const after = (await panel.innerText()).trim();
    if (after === before) throw new Error('panel text did not change after lang toggle');
    const afterLang = (await dataState(page)).lang;
    return `lang "${beforeLang || '?'}" → "${afterLang || '?'}"`;
  });

  // 5. Theme toggle changes data-theme
  let themeAfterToggle = '';
  await check('theme toggle changes document.documentElement.dataset.theme', async () => {
    const before = (await dataState(page)).theme;
    await page.locator(THEME_TOGGLE).first().click({ timeout: 5000 });
    await page.waitForFunction(
      (prev) => (document.documentElement.dataset.theme || '') !== prev,
      before,
      { timeout: 5000, polling: 100 },
    ).catch(() => {});
    themeAfterToggle = (await dataState(page)).theme;
    if (themeAfterToggle === before) throw new Error(`theme stayed "${before || '(unset)'}"`);
    return `theme "${before || '(unset)'}" → "${themeAfterToggle}"`;
  });

  // 6. Flights layer exists
  await check('flights layer exists', async () => {
    const count = await page.locator(FLIGHTS).count();
    if (count < 1) throw new Error(`${FLIGHTS} not found`);
    return `${count} element(s)`;
  });

  // 7. Spotlight receives text within 12 s
  await check('spotlight has text within 12 s', async () => {
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return !!el && el.textContent.trim().length > 0;
      },
      SPOTLIGHT,
      { timeout: 12000, polling: 250 },
    );
    const text = (await page.locator(SPOTLIGHT).first().textContent()).trim();
    return `"${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`;
  });

  // 8. Screenshot after toggles (light/en expected from dark/zh start)
  const finalState = await dataState(page);
  await shot(page, `03-${finalState.theme || 'default'}-${finalState.lang || 'default'}.png`);

  // Non-fatal: horizontal overflow at phone width
  try {
    const phone = await context.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(BASE_URL, { waitUntil: 'load', timeout: 30000 });
    await phone.waitForFunction(
      (sel) => document.querySelectorAll(sel).length > 150,
      MAP_SELECTOR,
      { timeout: 30000, polling: 250 },
    ).catch(() => {});
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) warnings.push(`phone width 390px: page scrolls horizontally by ${overflow}px`);
    await shot(phone, `04-phone-${finalState.theme || 'default'}.png`);
    await phone.close();
  } catch (err) {
    warnings.push(`phone-width check skipped: ${err.message.split('\n')[0]}`);
  }

  // Console errors collected across the run
  record(
    'no console errors',
    consoleErrors.length === 0,
    consoleErrors.length === 0 ? '' : `${consoleErrors.length} error(s)`,
  );

  // 9. Inbound flights board (after the console check: data/arrivals.json is published outside git,
  //    so a local 404 is expected and only has to render a status message)
  await check('arrivals board opens and renders', async () => {
    await page.locator('[data-testid="arrivals-toggle"]').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="arrivals"]');
      return !!el && !el.hidden && (el.querySelector('.arr-row, .arr-empty, .arr-summary') !== null);
    }, null, { timeout: 10000, polling: 250 });
    const rows = await page.locator('[data-testid="arrivals"] .arr-row').count();
    await shot(page, '05-arrivals.png');
    await page.locator('[data-testid="arrivals-toggle"]').click();
    if (!(await page.locator('[data-testid="arrivals"]').isHidden())) throw new Error('board did not close');
    return `${rows} flight row(s)`;
  });

  // 10. Outbreak route watch: menu switch draws the Irkutsk network and switching it off removes it
  await check('outbreak route watch (from the menu) toggles the map layer and marks the menu button', async () => {
    await page.locator('[data-testid="menu-toggle"]').click();
    await page.locator('#phone-menu [data-proxy="watch-toggle"]').click();
    await page.locator('[data-testid="watch-menu"] .wt-switch').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.watch-layer:not([hidden]) .wt-arc').length > 10, null, { timeout: 8000, polling: 250 });
    const arcs = await page.locator('.wt-arc').count();
    assert(await page.evaluate(() => document.querySelector('[data-testid="menu-toggle"]').classList.contains('has-active')), 'no dot on the menu button');
    await shot(page, '06-watch.png');
    await page.locator('[data-testid="watch-menu"] .wt-switch').first().click();
    await page.waitForFunction(() => document.querySelector('.watch-layer')?.hidden === true, null, { timeout: 4000 });
    await page.locator('[data-testid="watch-menu"] .wt-close').click();
    return `${arcs} arcs`;
  });

  // 11. Map layer switch: MOFA/MAC travel warnings re-colour the map and add a panel section
  await check('travel-warning layer switch (MOFA/MAC)', async () => {
    const mofa = page.locator('[data-testid="layer-switch"] .seg-mofa');
    await page.waitForFunction(() => !document.querySelector('[data-testid="layer-switch"] .seg-mofa')?.disabled, null, { timeout: 8000, polling: 250 });
    await mofa.click();
    await page.waitForFunction(() => document.querySelectorAll('path.country.wl-4').length > 5, null, { timeout: 5000, polling: 250 });
    const red = await page.locator('path.country.wl-4').count();
    await page.evaluate(() => window.__safetravel.openCountry('CN'));
    await page.waitForSelector('#panel .psec-wl', { timeout: 5000 });
    const text = await page.locator('#panel .psec-wl').innerText();
    if (!/陸委會|MAC/.test(text)) throw new Error('MAC section missing for CN');
    await shot(page, '07-warnings.png');
    await page.evaluate(() => window.__safetravel.closePanel());
    await page.locator('[data-testid="layer-switch"] .seg-cdc').click();
    await page.waitForFunction(() => !document.querySelector('path.country.wl-4'), null, { timeout: 4000 });
    return `${red} red countries`;
  });

  // 12. Weather overlay (CWA world-city forecast): off by default, lazy, persistent, deep-linkable
  const WX_BTN = '[data-testid="weather-toggle"]';
  const wxReady = (p) => p.waitForFunction(() => window.__safetravel?.weather?.status() === 'ready', null, { timeout: 15000, polling: 200 });
  const wxShown = (p) => p.evaluate(() => [...document.querySelectorAll('[data-testid="weather-marker"]')]
    .filter((e) => !e.closest('[hidden]') && getComputedStyle(e).display !== 'none').length);
  await check('weather overlay is off by default and fetches nothing', async () => {
    const r = await page.evaluate(() => ({
      pressed: document.querySelector('[data-testid="weather-toggle"]').getAttribute('aria-pressed'),
      markers: document.querySelectorAll('[data-testid="weather-marker"]').length,
      bar: document.querySelector('[data-testid="weather-bar"]').hidden,
      legend: !!document.querySelector('#legend .legend-wx'),
      foot: document.querySelector('.foot a[href*="opendata.cwa.gov.tw"]')?.getAttribute('href') || '',
    }));
    if (r.pressed !== 'false' || r.markers || !r.bar || r.legend) throw new Error(`not off: ${JSON.stringify(r)}`);
    if (wxRequests.length) throw new Error(`fetched while off: ${wxRequests[0]}`);
    if (!r.foot.startsWith('https://opendata.cwa.gov.tw/')) throw new Error('no CWA footer credit');
    return 'no markers, no weather requests';
  });

  await check('weather toggle shows 80 markers, the day bar and the legend block', async () => {
    await page.locator(WX_BTN).click();
    await wxReady(page);
    await page.locator('#zoom-reset').click();
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => ({
      pressed: document.querySelector('[data-testid="weather-toggle"]').getAttribute('aria-pressed'),
      markers: document.querySelectorAll('[data-testid="weather-marker"]').length,
      full: document.querySelectorAll('[data-testid="weather-marker"].is-full').length,
      bar: !document.querySelector('[data-testid="weather-bar"]').hidden,
      days: document.querySelectorAll('[data-testid="weather-bar"] [data-day]').length,
      legend: document.querySelector('#legend .legend-wx')?.textContent || '',
      stored: localStorage.getItem('safetravel.weather'),
      named: [...document.querySelectorAll('[data-testid="weather-marker"]')].every((e) => /°/.test(e.getAttribute('aria-label') || '')),
    }));
    if (r.pressed !== 'true' || r.markers !== 80) throw new Error(`pressed ${r.pressed}, ${r.markers} markers`);
    if (!r.bar || r.days !== 7) throw new Error(`day bar ${r.bar}, ${r.days} days`);
    if (!/CWA|中央氣象署/.test(r.legend) || !/°/.test(r.legend)) throw new Error(`legend "${r.legend.slice(0, 60)}"`);
    if (r.stored !== 'on') throw new Error(`stored ${r.stored}`);
    if (!r.named) throw new Error('a marker has no accessible name');
    if (r.full < 10) throw new Error(`only ${r.full} full markers`);
    await shot(page, '08-weather.png');
    return `${r.markers} markers (${r.full} full)`;
  });

  await check('weather day selector changes the Tokyo marker', async () => {
    const exp = await page.evaluate(async () => {
      const d = await (await fetch('data/weather.json')).json();
      return d.cities.find((c) => c.id === '47662').days.map((x) => x.max);
    });
    const temp = async () => (await page.locator('[data-testid="weather-marker"][data-city="47662"] .wxm-t').textContent()).replace('−', '-');
    const d0 = await temp();
    await page.locator('[data-testid="weather-day-1"]').click();
    const d1 = await temp();
    const pressed = await page.locator('[data-testid="weather-day-1"]').getAttribute('aria-pressed');
    await page.locator('[data-testid="weather-day-0"]').click();
    if (d0 !== `${exp[0]}°` || d1 !== `${exp[1]}°`) throw new Error(`Tokyo ${d0} → ${d1}, expected ${exp[0]}° → ${exp[1]}°`);
    if (pressed !== 'true') throw new Error('day 2 not pressed');
    return `Tokyo ${d0} → ${d1}`;
  });

  await check('activating a weather marker opens the country panel with local weather', async () => {
    await page.locator('#zoom-reset').click();
    await page.waitForTimeout(1000);
    const tokyo = page.locator('[data-testid="weather-marker"][data-city="47662"]');
    await tokyo.focus();
    await page.keyboard.press('ArrowRight');
    const moved = await page.evaluate(() => document.activeElement?.dataset.city);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash === '#/country/JP', null, { timeout: 5000 });
    const sec = page.locator(`${PANEL} [data-testid="panel-weather"]`);
    await sec.waitFor({ state: 'visible', timeout: 5000 });
    const rows = await sec.locator('tbody tr').count();
    const letter = await sec.locator('.psec-idx').textContent();
    await shot(page, '09-weather-panel.png');
    await page.evaluate(() => window.__safetravel.closePanel());
    if (!moved || moved === '47662') throw new Error(`arrow key focus ${moved}`);
    if (rows !== 2) throw new Error(`${rows} cities for JP`);
    return `#/country/JP, section ${letter.trim()}, ${rows} cities`;
  });

  await check('weather choice persists across a reload', async () => {
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 150, MAP_SELECTOR, { timeout: 30000 });
    await wxReady(page);
    const n = await page.locator('[data-testid="weather-marker"]').count();
    const pressed = await page.locator(WX_BTN).getAttribute('aria-pressed');
    if (n !== 80 || pressed !== 'true') throw new Error(`${n} markers, pressed ${pressed}`);
    return `${n} markers after reload`;
  });

  await check('toggling the weather overlay off removes the markers and panel section', async () => {
    await page.locator(WX_BTN).click();
    await page.waitForTimeout(300);
    const shown = await wxShown(page);
    await page.evaluate(() => window.__safetravel.openCountry('JP'));
    await page.locator(PANEL).waitFor({ state: 'visible', timeout: 5000 });
    const sec = await page.locator(`${PANEL} [data-testid="panel-weather"]`).count();
    const r = await page.evaluate(() => ({
      bar: document.querySelector('[data-testid="weather-bar"]').hidden,
      legend: !!document.querySelector('#legend .legend-wx'),
      stored: localStorage.getItem('safetravel.weather'),
    }));
    await page.evaluate(() => window.__safetravel.closePanel());
    if (shown || sec || !r.bar || r.legend || r.stored !== 'off') throw new Error(`still on: ${shown} markers, section ${sec}, ${JSON.stringify(r)}`);
    return 'markers, bar, legend and panel section gone';
  });

  await check('?wx=1 turns the overlay on and ?wx=0 keeps it off', async () => {
    const ctx = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
    const p1 = await ctx.newPage();
    const errs = [];
    p1.on('pageerror', (e) => errs.push(e.message));
    await p1.goto(`${BASE_URL}?wx=1`, { waitUntil: 'load' });
    await p1.waitForFunction((sel) => document.querySelectorAll(sel).length > 150, MAP_SELECTOR, { timeout: 30000 });
    await wxReady(p1);
    const on = await p1.locator('[data-testid="weather-marker"]').count();
    // stored "on" + ?wx=0: the link wins and nothing is fetched
    const reqs = [];
    p1.on('request', (req) => { if (/weather\.json/.test(req.url())) reqs.push(req.url()); });
    await p1.goto(`${BASE_URL}?wx=0`, { waitUntil: 'load' });
    await p1.waitForFunction((sel) => document.querySelectorAll(sel).length > 150, MAP_SELECTOR, { timeout: 30000 });
    await p1.waitForTimeout(800);
    const off = await p1.evaluate(() => ({
      markers: document.querySelectorAll('[data-testid="weather-marker"]').length,
      pressed: document.querySelector('[data-testid="weather-toggle"]').getAttribute('aria-pressed'),
    }));
    const offReqs = reqs.length; // counted before the click below, which switches the overlay on and fetches
    // the toggle keeps a shared ?wx= link in sync
    await p1.locator(WX_BTN).click();
    const url = await p1.evaluate(() => location.search);
    await ctx.close();
    if (on !== 80) throw new Error(`?wx=1 → ${on} markers`);
    if (off.markers || off.pressed !== 'false' || offReqs) throw new Error(`?wx=0 → ${JSON.stringify(off)}, ${offReqs} request(s)`);
    if (url !== '?wx=1') throw new Error(`URL after toggle ${url}`);
    if (errs.length) throw new Error(errs[0]);
    return `on: ${on} markers; off: no fetch; URL synced`;
  });

  await check('?lang=en pins English over a stored Chinese choice; the language button keeps ?lang in step', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('safetravel.lang', 'zh-Hant'); } catch {} });
    const pr = await ctx.newPage();
    const errs = [];
    pr.on('pageerror', (e) => errs.push(e.message));
    const u = new URL(BASE_URL);
    u.search = '?arr=TPE-ABCD&wx=1&text=m&months=6&full=1&lang=en';
    await pr.goto(u.href, { waitUntil: 'load' });
    await pr.waitForFunction(() => document.documentElement.lang === 'en' && !document.documentElement.classList.contains('i18n-pending'), null, { timeout: 15000 });
    await pr.waitForFunction((sel) => document.querySelectorAll(sel).length > 150, MAP_SELECTOR, { timeout: 30000 });
    const title = await pr.title();
    const stored = await pr.evaluate(() => localStorage.getItem('safetravel.lang'));
    await pr.click('[data-testid="lang-toggle"]');
    await pr.waitForFunction(() => document.documentElement.lang === 'zh-Hant', null, { timeout: 5000 });
    const search = await pr.evaluate(() => location.search);
    await ctx.close();
    if (!/Radar/.test(title)) throw new Error(`title ${title}`);
    if (stored !== 'zh-Hant') throw new Error(`?lang must not be stored (${stored})`);
    if (!/[?&]lang=zh(&|$)/.test(search)) throw new Error(`URL after toggle ${search}`);
    if (errs.length) throw new Error(errs[0]);
    return `${title}; after toggle ${search}`;
  });

  await check('search finds airports and cities (NRT, 成田, 曼谷 → BKK) and opens their country', async () => {
    const pr = await context.newPage();
    const errs = [];
    pr.on('pageerror', (e) => errs.push(e.message));
    await pr.goto(BASE_URL, { waitUntil: 'load' });
    await pr.waitForFunction((sel) => document.querySelectorAll(sel).length > 150, MAP_SELECTOR, { timeout: 30000 });
    const opts = async (q) => {
      await pr.fill('[data-testid="search"]', q);
      await pr.waitForFunction(() => document.querySelectorAll('#search-list .opt-place').length > 0, null, { timeout: 8000 }).catch(() => {});
      return pr.$$eval('#search-list li[role="option"]', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
    };
    const nrt = await opts('nrt');
    const narita = await opts('成田');
    const bangkok = await opts('曼谷');
    await pr.fill('[data-testid="search"]', 'NRT');
    await pr.waitForTimeout(200);
    await pr.keyboard.press('Enter');
    await pr.waitForFunction(() => location.hash === '#/country/JP', null, { timeout: 5000 });
    await pr.close();
    assert(nrt[0]?.includes('NRT') && /日本|Japan/.test(nrt[0] || ''), `nrt → ${nrt[0]}`);
    assert(narita.some((o) => o.includes('NRT')), `成田 → ${narita.join(' | ')}`);
    assert(bangkok.some((o) => o.includes('BKK')) && bangkok.some((o) => o.includes('DMK')), `曼谷 → ${bangkok.join(' | ')}`);
    assert(!errs.length, errs[0]);
    return `nrt → ${nrt[0]}; 曼谷 → BKK, DMK; Enter opens #/country/JP`;
  });

  await check('text size: 特大 by default on desktop, the button cycles and is remembered, ?text= overrides, layout holds', async () => {
    const ctx = await page.context().browser().newContext({ viewport: { width: 1600, height: 900 } });
    const pr = await ctx.newPage();
    const errs = [];
    pr.on('pageerror', (e) => errs.push(e.message));
    const state = () => pr.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      const tiles = r('#stat-tiles'); const tb = r('.toolbar'); const top = r('.hud-top'); const panel = r('#panel');
      return {
        ts: document.documentElement.dataset.ts, fs: parseFloat(getComputedStyle(document.body).fontSize),
        stored: localStorage.getItem('safetravel.textSize'), label: document.querySelector('[data-testid="textsize-toggle"]').getAttribute('aria-label'),
        toolbarBelowTiles: tb.top >= tiles.bottom - 4, panelBelowHeader: !panel || panel.height === 0 || panel.top >= top.bottom,
        scrollX: document.documentElement.scrollWidth - innerWidth,
      };
    });
    await pr.goto(`${BASE_URL}#/country/JP`, { waitUntil: 'load' });
    await pr.waitForFunction((sel) => document.querySelectorAll(sel).length > 150, MAP_SELECTOR, { timeout: 30000 });
    await pr.waitForTimeout(800);
    const d = await state();
    const seen = [d.ts];
    const xl = d; // the default is the largest size: check the layout there, then cycle round
    for (let i = 0; i < 4; i++) { await pr.click('[data-testid="textsize-toggle"]'); await pr.waitForTimeout(400); seen.push((await state()).ts); }
    const after = await state();
    await pr.reload({ waitUntil: 'load' });
    await pr.waitForFunction((sel) => document.querySelectorAll(sel).length > 150, MAP_SELECTOR, { timeout: 30000 });
    const kept = await state();
    await pr.goto(`${BASE_URL}?text=s`, { waitUntil: 'load' });
    const q = await state();
    await ctx.close();
    assert(d.ts === 'xl' && Math.abs(d.fs - 14 * 1.4) < 0.1 && d.stored === null, `default ${JSON.stringify(d)}`);
    assert(seen.join('') === 'xlsmlxl' && after.stored === 'xl', `cycle ${seen} ${JSON.stringify(after)}`);
    assert(xl.toolbarBelowTiles && xl.panelBelowHeader && xl.scrollX === 0, `layout at xl ${JSON.stringify(xl)}`);
    assert(kept.ts === 'xl' && q.ts === 's' && q.stored === 'xl', `reload ${kept.ts}, ?text=s ${q.ts} (stored ${q.stored})`);
    assert(/特大|XL/.test(xl.label), `label ${xl.label}`);
    assert(!errs.length, errs[0]);
    return `default xl (body ${d.fs}px), cycles s → m → l → xl, kept after reload, ?text=s overrides`;
  });

  await check('arrivals board: flight search (JK202, jk-202, JK0202, codeshare BR2101) across checkpoints and a wider window', async () => {
    const now = Date.now();
    const iso = (min) => new Date(now + min * 60000 + 8 * 3600000).toISOString().slice(0, 16) + '+08:00';
    const fl = (id, flight, cs, cp, min, from = 'NRT', zh = '東京成田') => ({
      id, airport: 'TPE', flight, airline: flight.slice(0, 2), codeshares: cs, from, from_zh: zh, from_en: zh, country: 'JP', lat: 35.76, lon: 140.39,
      terminal: cp === 'A' || cp === 'B' ? '1' : '2', gate: `${cp}5`, checkpoint: cp, apron: '', carousel: '03',
      scheduled: iso(min), estimated: iso(min), actual: null, status: 'on_time', status_zh: '準時', status_en: 'ON TIME', aircraft: 'A321',
    });
    const doc = {
      generated_at: iso(0), source: 'tdx', endpoint: 'test', tdx_updated: iso(0), window: { from: iso(-120), to: iso(240) },
      refresh_minutes: { day: 10, night: 30 }, quota: { month: '2026-11', calls_month: 1, cap_month: 4200, day: '2026-11-04', calls_day: 1 },
      airports: { TPE: { name_zh: '桃園', name_en: 'Taoyuan', lat: 25.08, lon: 121.23, flights: 3, checkpoints: [{ id: 'A', terminal: '1' }, { id: 'B', terminal: '1' }, { id: 'C', terminal: '2' }, { id: 'D', terminal: '2' }] } },
      flights: [fl('a', 'CI 101', ['BR 2101'], 'A', 10), fl('c', 'JK 202', [], 'C', 30, 'ICN', '首爾仁川'), fl('old', 'CI 777', [], 'A', -90)],
    };
    const pr = await context.newPage();
    const errs = [];
    pr.on('pageerror', (e) => errs.push(e.message));
    await pr.route('**/data/arrivals.json*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(doc) }));
    await pr.goto(`${BASE_URL}?arr=TPE-A`, { waitUntil: 'load' });
    await pr.waitForFunction(() => document.querySelectorAll('#arrivals .arr-row').length > 0, null, { timeout: 30000 });
    const rows = () => pr.$$eval('#arrivals .arr-row .arr-flight', (ls) => ls.map((l) => l.textContent.trim()));
    const base = await rows();
    const res = {};
    for (const q of ['JK202', 'jk-202', 'JK0202', 'jk 2', 'BR2101', '首爾', 'CI 777', 'ZZ9']) {
      await pr.fill('[data-testid="arrivals-search"]', q);
      await pr.waitForTimeout(150);
      res[q] = await rows();
    }
    await pr.press('[data-testid="arrivals-search"]', 'Escape');
    await pr.waitForTimeout(150);
    const after = await rows();
    // several checkpoints at once (A + C), then back to all
    await pr.click('[data-testid="arrivals-cp"]');
    await pr.click('#arrivals .arr-cp-opt[data-cp="C"]');
    const ac = (await rows()).sort();
    const cpLabel = (await pr.textContent('[data-testid="arrivals-cp"]')).replace(/\s+/g, '');
    await pr.click('#arrivals .arr-cp-opt[data-cp="ALL"]');
    const all = (await rows()).sort();
    await pr.keyboard.press('Escape');
    const status = await pr.evaluate(() => ({ kicker: document.querySelector('#arrivals .arr-kicker').textContent, quota: document.querySelector('[data-arr-quota]')?.textContent || '' }));
    const belt = await pr.$eval('#arrivals .arr-belt', (e) => e.textContent.replace(/\s+/g, ''));
    await pr.close();
    assert(base.join() === 'CI 101', `checkpoint A without search: ${base}`);
    for (const q of ['JK202', 'jk-202', 'JK0202', 'jk 2', '首爾']) assert(res[q].join() === 'JK 202', `${q} → ${res[q]}`);
    assert(res.BR2101.join() === 'CI 101', `codeshare → ${res.BR2101}`);
    assert(res['CI 777'].join() === 'CI 777', `90 min ago, outside ±60 → ${res['CI 777']}`);
    assert(res.ZZ9.length === 0 && after.join() === 'CI 101', `none ${res.ZZ9}, after Esc ${after}`);
    assert(/03/.test(belt), `carousel ${belt}`);
    assert(ac.join() === 'CI 101,JK 202' && /A、C/.test(cpLabel), `A + C: ${ac} (${cpLabel})`);
    assert(all.join() === 'CI 101,JK 202', `all checkpoints: ${all}`);
    assert(!/MIN|±/.test(status.kicker) && /API/.test(status.quota), `status ${JSON.stringify(status)}`);
    assert(!errs.length, errs[0]);
    return 'all formats find JK 202 (other checkpoint), codeshare and −90 min flights found, Esc restores';
  });

  await check('arrivals.html: full-screen board, time window ±30/±60/all, "only L2+" filter, row opens trip.html', async () => {
    const now = Date.now();
    const iso = (min) => new Date(now + min * 60000 + 8 * 3600000).toISOString().slice(0, 16) + '+08:00';
    const fl = (id, flight, min, country, from) => ({
      id, airport: 'TPE', flight, airline: flight.slice(0, 2), codeshares: [], from, from_zh: from, from_en: from, country, lat: 20, lon: 110,
      terminal: '1', gate: 'A5', checkpoint: 'A', apron: '', scheduled: iso(min), estimated: iso(min), actual: null,
      status: 'on_time', status_zh: '準時', status_en: 'ON TIME', aircraft: 'A321',
    });
    const l2 = await page.evaluate(() => Object.entries(window.__safetravel.state.data.alerts.countries).find(([, v]) => v.max_level === 2)?.[0]);
    const doc = {
      generated_at: iso(0), source: 'tdx', endpoint: 'test', tdx_updated: iso(0), window: { from: iso(-120), to: iso(240) },
      refresh_minutes: { day: 10, night: 30 }, quota: null,
      airports: { TPE: { name_zh: '桃園', name_en: 'Taoyuan', lat: 25.08, lon: 121.23, flights: 3, checkpoints: [{ id: 'A', terminal: '1' }] } },
      flights: [fl('a', 'CI 101', 10, 'JP', 'NRT'), fl('b', 'BR 384', 45, l2, 'XXA'), fl('c', 'CI 777', -100, 'JP', 'KIX')],
    };
    const ctx = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 } });
    const pr = await ctx.newPage();
    const errs = [];
    pr.on('pageerror', (e) => errs.push(e.message));
    pr.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await pr.route('**/data/arrivals.json*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(doc) }));
    await pr.goto(new URL('arrivals.html', BASE_URL).href, { waitUntil: 'load' });
    await pr.waitForFunction(() => document.querySelectorAll('#arrivals .arr-row').length > 0, null, { timeout: 15000 });
    const rows = () => pr.$$eval('#arrivals .arr-row .arr-flight', (ls) => ls.map((l) => l.textContent.trim()).sort());
    const r60 = await rows();
    await pr.selectOption('[data-testid="arrivals-window"]', '30');
    const r30 = await rows();
    await pr.selectOption('[data-testid="arrivals-window"]', '0');
    const rAll = await rows();
    await pr.click('#arrivals [data-risk]');
    const rRisk = await rows();
    const fills = await pr.evaluate(() => { const r = document.querySelector('#arrivals').getBoundingClientRect(); return r.width >= innerWidth - 2 && r.bottom >= innerHeight - 2; });
    await pr.click('#arrivals .arr-hit[data-iso]');
    await pr.waitForURL(/trip\.html#/, { timeout: 10000 });
    const url = pr.url();
    await ctx.close();
    assert(r60.join() === 'BR 384,CI 101', `±60: ${r60}`);
    assert(r30.join() === 'CI 101', `±30: ${r30}`);
    assert(rAll.join() === 'BR 384,CI 101,CI 777', `all: ${rAll}`);
    assert(rRisk.join() === 'BR 384', `only L2+: ${rRisk}`);
    assert(fills, 'the board does not fill the page');
    assert(url.endsWith(`trip.html#${l2}`), `row opened ${url}`);
    assert(!errs.length, errs[0]);
    return `windows 2/1/3 rows, L2+ filter keeps ${l2}, row → trip.html`;
  });

  await check('m.html quick check: role chooser, traveller search → card, officer flights tab and flight search', async () => {
    const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const pm = await ctx.newPage();
    const errs = [];
    pm.on('pageerror', (e) => errs.push(e.message));
    pm.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    const now = Date.now();
    const iso = (min) => new Date(now + min * 60000 + 8 * 3600000).toISOString().slice(0, 16) + '+08:00';
    const doc = {
      generated_at: iso(0), source: 'tdx', endpoint: 'test', tdx_updated: iso(0), window: { from: iso(-120), to: iso(240) },
      refresh_minutes: { day: 10, night: 30 }, quota: null,
      airports: { TPE: { name_zh: '桃園', name_en: 'Taoyuan', lat: 25.08, lon: 121.23, flights: 1, checkpoints: [] } },
      flights: [{ id: 'x', airport: 'TPE', flight: 'BR 384', airline: 'BR', codeshares: [], from: 'DAD', from_zh: '峴港', from_en: 'Da Nang', country: 'VN',
        lat: 16, lon: 108, terminal: '2', gate: 'B9', checkpoint: 'B', apron: '', scheduled: iso(20), estimated: iso(20), actual: null,
        status: 'on_time', status_zh: '準時', status_en: 'ON TIME', aircraft: 'A321' }],
    };
    await pm.route('**/data/arrivals.json*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(doc) }));
    await pm.goto(new URL('m.html', BASE_URL).href, { waitUntil: 'load' });
    await pm.waitForSelector('#role-dialog:not([hidden])', { timeout: 10000 });
    await pm.tap('[data-testid="role-public"]');
    const pubFlightsHidden = await pm.locator('[data-testid="tab-flights"]').isHidden();
    await pm.fill('#m-q', '泰國');
    await pm.waitForSelector('#m-results li[data-iso="TH"]', { timeout: 5000 });
    await pm.press('#m-q', 'Enter');
    await pm.waitForSelector('[data-testid="country-card"][data-iso="TH"]', { timeout: 5000 });
    const card = await pm.locator('[data-testid="country-card"]').textContent();
    await pm.goto(new URL('m.html?role=officer', BASE_URL).href, { waitUntil: 'load' });
    await pm.waitForSelector('body[data-ready="1"]', { timeout: 10000 });
    await pm.tap('[data-testid="tab-flights"]');
    await pm.waitForSelector('#view-flights .f-row', { timeout: 10000 });
    await pm.fill('#m-q', 'br384');
    await pm.waitForSelector('#m-results li[data-fid="x"]', { timeout: 5000 });
    await pm.tap('#m-results li[data-fid="x"]');
    await pm.waitForSelector('[data-testid="country-card"][data-iso="VN"] .f-row.is-hit', { timeout: 5000 });
    const over = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const role = await pm.evaluate(() => localStorage.getItem('safetravel.role'));
    await ctx.close();
    assert(pubFlightsHidden, 'travellers see the flights tab');
    assert(/疾管署/.test(card) && /外交部/.test(card), `card text: ${card.slice(0, 80)}`);
    assert(role === 'officer', `role stored ${role}`);
    assert(over <= 1, `horizontal overflow ${over}px`);
    assert(!errs.length, errs[0]);
    return 'traveller: 泰國 card; officer: flights tab, BR384 → Vietnam card with the flight highlighted';
  });

  await check('phone menu: header keeps board + menu, the sheet lists the 5 pages and switches with their state', async () => {
    const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const ph = await ctx.newPage();
    await ph.addInitScript(() => { try { localStorage.setItem('safetravel.mpromo', 'off'); } catch (e) { /* ignore */ } });
    await ph.goto(BASE_URL, { waitUntil: 'load' });
    await ph.waitForFunction((sel) => document.querySelectorAll(sel).length > 150, MAP_SELECTOR, { timeout: 30000 });
    const head = await ph.evaluate(() => ['menu-toggle', 'arrivals-toggle', 'theme-toggle', 'watch-toggle', 'lang-toggle']
      .map((id) => [id, document.querySelector(`[data-testid="${id}"]`).getClientRects().length > 0]));
    await ph.tap('[data-testid="menu-toggle"]');
    const links = await ph.$$eval('#phone-menu a.pm-item', (as) => as.map((a) => a.getAttribute('href')));
    const before = await ph.evaluate(() => document.documentElement.dataset.theme);
    await ph.tap('#phone-menu [data-proxy="theme-toggle"]');
    const after = await ph.evaluate(() => ({ theme: document.documentElement.dataset.theme, open: !document.querySelector('#phone-menu').hidden,
      state: document.querySelector('#phone-menu [data-proxy="theme-toggle"] .pm-state').textContent }));
    await ph.tap('#phone-menu [data-proxy="arrivals-toggle"]');
    const board = await ph.evaluate(() => !document.querySelector('#arrivals').hidden && document.querySelector('#phone-menu').hidden);
    await ctx.close();
    const shown = Object.fromEntries(head);
    assert(shown['menu-toggle'] && shown['arrivals-toggle'] && !shown['theme-toggle'] && !shown['watch-toggle'] && !shown['lang-toggle'], `header ${JSON.stringify(shown)}`);
    assert(links.join() === 'm.html,trip.html,arrivals.html,slide.html,help.html', `pages ${links}`);
    assert(after.theme !== before && after.open && after.state, `theme switch ${JSON.stringify(after)}`);
    assert(board, 'the board did not open from the menu');
    return '5 pages, switches keep the sheet open, the board closes it';
  });

  await check('help.html: both languages, every contents link has its section, #sources works in English, footer links here', async () => {
    const foot = await page.evaluate(() => ({ help: document.querySelector('[data-testid="footer-help-link"]')?.getAttribute('href'),
      more: document.querySelector('.foot-more')?.getAttribute('href') }));
    const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const ph = await ctx.newPage();
    const errs = [];
    ph.on('pageerror', (e) => errs.push(e.message));
    ph.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await ph.goto(new URL('help.html', BASE_URL).href, { waitUntil: 'load' });
    await ph.waitForSelector('body[data-ready="1"]');
    const toc = await ph.evaluate(() => [...document.querySelectorAll('.toc a')].map((a) => a.getAttribute('href')).filter((h) => !document.getElementById(h.slice(1))));
    const zh = await ph.evaluate(() => ({ zh: !document.querySelector('[data-lang="zh"]').hidden, en: !document.querySelector('[data-lang="en"]').hidden,
      over: document.documentElement.scrollWidth - innerWidth, secs: document.querySelectorAll('[data-lang="zh"] section').length }));
    await ph.tap('[data-testid="lang-toggle"]');
    await ph.goto(new URL('index.html', BASE_URL).href);
    await ph.goto(new URL('help.html#sources', BASE_URL).href, { waitUntil: 'load' });
    await ph.waitForSelector('body[data-ready="1"]');
    await ph.waitForTimeout(300);
    const en = await ph.evaluate(() => ({ lang: document.documentElement.lang, top: Math.round(document.getElementById('en-sources').getBoundingClientRect().top),
      secs: document.querySelectorAll('[data-lang="en"] section').length }));
    await ctx.close();
    assert(foot.help === 'help.html' && foot.more === 'help.html#sources', `footer ${JSON.stringify(foot)}`);
    assert(!toc.length, `contents links without a section: ${toc}`);
    assert(zh.zh && !zh.en && zh.over <= 1 && zh.secs >= 11, `zh ${JSON.stringify(zh)}`);
    assert(en.lang === 'en' && en.top >= 0 && en.top < 200 && en.secs === zh.secs, `en ${JSON.stringify(en)}`);
    assert(!errs.length, errs[0]);
    return `${zh.secs} sections in both languages, #sources → #en-sources`;
  });

  await check('country panel: drag its head to float it (remembered after reload), the dock button puts it back', async () => {
    const ctx = await page.context().browser().newContext({ viewport: { width: 1600, height: 900 } });
    const pp = await ctx.newPage();
    await pp.goto(`${BASE_URL}#/country/JP`, { waitUntil: 'load' });
    await pp.waitForFunction(() => document.querySelector('#panel')?.classList.contains('is-open'), null, { timeout: 30000 });
    await pp.waitForTimeout(600);
    const r0 = await pp.locator('#panel').boundingBox();
    await pp.mouse.move(r0.x + 140, r0.y + 18);
    await pp.mouse.down();
    await pp.mouse.move(r0.x - 100, r0.y + 60, { steps: 6 });
    await pp.mouse.move(r0.x - 400, r0.y + 80, { steps: 6 });
    await pp.mouse.up();
    const r1 = await pp.locator('#panel').boundingBox();
    const fl = await pp.evaluate(() => document.querySelector('#panel').classList.contains('is-floating') && !document.querySelector('.panel-dock').hidden);
    await pp.reload({ waitUntil: 'load' });
    await pp.waitForFunction(() => document.querySelector('#panel')?.classList.contains('is-open'), null, { timeout: 30000 });
    await pp.waitForTimeout(700); // slide-in transition
    const r2 = await pp.locator('#panel').boundingBox();
    await pp.click('.panel-dock');
    const r3 = await pp.locator('#panel').boundingBox();
    const stored = await pp.evaluate(() => localStorage.getItem('safetravel.panel.pos'));
    await ctx.close();
    assert(fl && Math.abs(r1.x - (r0.x - 400 - 140)) < 3, `not floating where dropped: ${JSON.stringify(r0)} → ${JSON.stringify(r1)}`);
    assert(Math.abs(r2.x - r1.x) < 3 && Math.abs(r2.y - r1.y) < 3, `position not remembered: ${JSON.stringify(r2)}`);
    assert(Math.abs(r3.x - r0.x) < 3 && stored === '{}', `dock: ${JSON.stringify(r3)} ${stored}`);
    return 'floats, survives a reload, docks back';
  });

  await check('boot guard: a stale cached module (half-updated cache) is re-downloaded and the page starts by itself', async () => {
    const ctx = await page.context().browser().newContext({ viewport: { width: 1440, height: 900 } });
    const pg = await ctx.newPage();
    let hits = 0;
    let loads = 0;
    pg.on('load', () => { loads++; });
    // first request: a hud.js that lacks an export app.js imports (what an old cached copy looks like after a deploy)
    await pg.route('**/js/hud.js*', (r) => { hits++; return hits === 1 ? r.fulfill({ contentType: 'text/javascript', body: 'export const nothing = 1;' }) : r.continue(); });
    await pg.goto(BASE_URL, { waitUntil: 'load' });
    const first = await pg.evaluate(() => document.documentElement.hasAttribute('data-booted'));
    await pg.waitForFunction((sel) => document.documentElement.hasAttribute('data-booted') && document.querySelectorAll(sel).length > 150, MAP_SELECTOR, { timeout: 30000 });
    await ctx.close();
    assert(!first, 'the stale module did not break the first load (test is not testing anything)');
    assert(loads === 2 && hits >= 3, `loads ${loads}, hud.js requests ${hits}`);
    return 'one automatic reload with fresh modules';
  });

  await check('spotlight card steps aside while the arrivals board or the country panel is open; its full-details switch is also in the menu', async () => {
    const ctx = await page.context().browser().newContext({ viewport: { width: 1600, height: 900 } });
    const pg = await ctx.newPage();
    await pg.goto(BASE_URL, { waitUntil: 'load' });
    await pg.waitForFunction((sel) => document.querySelectorAll(sel).length > 150, MAP_SELECTOR, { timeout: 30000 });
    const hid = () => pg.evaluate(() => document.querySelector('#spotlight').classList.contains('is-hidden'));
    const seq = [await hid()];
    await pg.click('[data-testid="arrivals-toggle"]'); seq.push(await hid());
    // the card's "show full details" switch is hidden with it: the menu carries the same switch
    await pg.click('[data-testid="menu-toggle"]');
    const before = await pg.textContent('[data-testid="menu-autoopen"] .pm-state');
    await pg.click('[data-testid="menu-autoopen"]');
    const after = await pg.evaluate(() => [document.querySelector('[data-testid="menu-autoopen"] .pm-state').textContent, window.__safetravel.state.spotlight.autoOpen]);
    await pg.click('[data-testid="menu-autoopen"]');
    await pg.keyboard.press('Escape');
    assert(before !== after[0] && after[1] === true, `menu switch ${before} → ${JSON.stringify(after)}`);
    await pg.evaluate(() => window.__safetravel.openCountry('JP')); seq.push(await hid());
    await pg.evaluate(() => window.__safetravel.closePanel()); seq.push(await hid());
    await pg.click('[data-testid="arrivals-toggle"]'); seq.push(await hid());
    await ctx.close();
    assert(seq.join() === 'false,true,true,true,false', `hidden sequence ${seq}`);
    return 'board / panel hide it, both closed bring it back';
  });

  await check('timeline range: 6 months by default, 3/6/12/24 switch the list, choice remembered, ?months= overrides', async () => {
    const pr = await context.newPage();
    const errs = [];
    pr.on('pageerror', (e) => errs.push(e.message));
    const ready = () => pr.waitForFunction(() => document.querySelectorAll('.psec-tl .tl-range-btn').length === 4 && !document.querySelector('.psec-tl .skeleton'), null, { timeout: 40000 });
    const st = () => pr.evaluate(() => ({
      pressed: +document.querySelector('.tl-range-btn[aria-pressed="true"]').dataset.months,
      count: +(document.querySelector('.psec-tl h3 .count')?.textContent.match(/\d+/)?.[0] ?? -1),
      stat: +document.querySelectorAll('.panel-stats dd')[1].textContent,
      stored: localStorage.getItem('safetravel.timelineMonths'),
    }));
    await pr.goto(`${BASE_URL}#/country/DE`, { waitUntil: 'load' });
    await ready();
    const d = await st();
    await pr.click('.tl-range-btn[data-months="24"]');
    const all = await st();
    await pr.goto(`${BASE_URL}?months=3#/country/DE`, { waitUntil: 'load' });
    await ready();
    const q = await st();
    await pr.evaluate(() => localStorage.removeItem('safetravel.timelineMonths'));
    await pr.close();
    assert(d.pressed === 6 && d.count === d.stat, `default ${JSON.stringify(d)}`);
    assert(all.pressed === 24 && all.count >= d.count && all.stored === '24' && all.stat === all.count, `24 months ${JSON.stringify(all)}`);
    assert(q.pressed === 3 && q.count <= d.count && q.stored === '24', `?months=3 ${JSON.stringify(q)}`);
    assert(!errs.length, errs[0]);
    return `DE: 6 mo ${d.count}, 2 yr ${all.count}, ?months=3 ${q.count}`;
  });

  await check('auto tour bar in the open panel: auto-scroll switch + "compact" back to the card view', async () => {
    const ctx = await page.context().browser().newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('safetravel.spotlightAutoOpen', 'on'); } });
    const pr = await ctx.newPage();
    const errs = [];
    pr.on('pageerror', (e) => errs.push(e.message));
    await pr.goto(BASE_URL, { waitUntil: 'load' });
    await pr.waitForFunction(() => !document.querySelector('#panel').hidden && !document.querySelector('.panel-autobar').hidden, null, { timeout: 45000 });
    const sw = '[data-testid="panel-autoscroll"]';
    const before = await pr.getAttribute(sw, 'aria-checked');
    await pr.click(sw);
    const flipped = await pr.evaluate(() => [document.querySelector('[data-testid="panel-autoscroll"]').getAttribute('aria-checked'), document.querySelector('[data-testid="spotlight-autoscroll"]').getAttribute('aria-checked')]);
    await pr.click(sw);
    await pr.click('[data-testid="panel-compact"]');
    await pr.waitForFunction(() => document.querySelector('#panel').hidden, null, { timeout: 3000 });
    await pr.evaluate(() => window.__safetravel.spotlight.next());
    await pr.waitForTimeout(1500);
    const after = await pr.evaluate(() => ({ hidden: document.querySelector('#panel').hidden, auto: document.querySelector('[data-testid="spotlight-autoopen"]').getAttribute('aria-checked'), stored: localStorage.getItem('safetravel.spotlightAutoOpen') }));
    await ctx.close();
    assert(before === 'true' && flipped[0] === 'false' && flipped[1] === 'false', `switch ${before} -> ${flipped}`);
    assert(after.hidden && after.auto === 'false' && after.stored === 'off', `compact ${JSON.stringify(after)}`);
    assert(!errs.length, errs[0]);
    return 'switch mirrors the card setting; compact closes the panel and the tour continues on the card';
  });

  await check('kiosk self-reload: new site code (version.json) reloads the map page at a quiet moment', async () => {
    const pr = await context.newPage();
    const errs = [];
    pr.on('pageerror', (e) => errs.push(e.message));
    let code = 'aaaa1111';
    await pr.route('**/version.json*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ code }) }));
    await pr.clock.install();
    await pr.goto(`${BASE_URL}?refreshEvery=1`, { waitUntil: 'load' });
    await pr.waitForFunction((sel) => document.querySelectorAll(sel).length > 150, MAP_SELECTOR, { timeout: 30000 });
    await pr.evaluate(() => { window.__marker = 1; });
    await pr.waitForTimeout(2500);
    assert(await pr.evaluate(() => !window.__safetravel.refresh.pending), 'pending without a change');
    code = 'bbbb2222';
    await pr.waitForFunction(() => window.__safetravel.refresh.pending?.reason === 'code', null, { timeout: 8000 });
    const reloaded = pr.waitForEvent('load', { timeout: 20000 });
    await pr.clock.fastForward('02:00');
    await reloaded;
    const marker = await pr.evaluate(() => window.__marker);
    await pr.close();
    assert(marker === undefined, 'page did not reload');
    assert(!errs.length, errs[0]);
    return 'code change detected and reloaded';
  });

  await check('phone 390 px with the overlay on: no overflow, tap shows the forecast, second tap opens the panel', async () => {
    const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const ph = await ctx.newPage();
    const errs = [];
    ph.on('pageerror', (e) => errs.push(e.message));
    ph.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await ph.goto(`${BASE_URL}?wx=1`, { waitUntil: 'load' });
    await ph.waitForFunction((sel) => document.querySelectorAll(sel).length > 150, MAP_SELECTOR, { timeout: 30000 });
    await wxReady(ph);
    await ph.waitForTimeout(1200);
    const m = await ph.evaluate(() => ({
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      markers: document.querySelectorAll('[data-testid="weather-marker"]').length,
      bar: document.querySelector('[data-testid="weather-bar"]').getBoundingClientRect(),
      vw: window.innerWidth,
    }));
    await shot(ph, '10-weather-phone.png');
    const dot = await ph.locator('[data-testid="weather-marker"][data-city="47662"] .wxm-dot').boundingBox();
    if (!dot) throw new Error('Tokyo marker not visible on the phone');
    await ph.touchscreen.tap(dot.x + dot.width / 2, dot.y + dot.height / 2);
    await ph.waitForFunction(() => !document.querySelector('#tooltip').hidden && /wxt-days/.test(document.querySelector('#tooltip').innerHTML), null, { timeout: 3000 });
    const hash1 = await ph.evaluate(() => location.hash);
    await ph.touchscreen.tap(dot.x + dot.width / 2, dot.y + dot.height / 2);
    await ph.waitForFunction(() => location.hash === '#/country/JP', null, { timeout: 5000 });
    await ctx.close();
    if (m.over > 1) throw new Error(`page scrolls horizontally by ${m.over}px`);
    if (m.markers !== 80) throw new Error(`${m.markers} markers`);
    if (m.bar.left < 0 || m.bar.right > m.vw) throw new Error('day bar outside the screen');
    if (hash1) throw new Error(`first tap navigated to ${hash1}`);
    if (errs.length) throw new Error(errs[0]);
    return `${m.markers} markers, no overflow`;
  });

  await check('legend is the level filter, collapses and is remembered; routes are inbound-only by default with a both-ways switch', async () => {
    const r0 = await page.evaluate(() => ({
      chips: !!document.querySelector('#level-chips'), rows: document.querySelectorAll('#legend .lg-filter').length,
      dir: window.__safetravel.state.flightDir, attr: document.documentElement.dataset.flightdir,
      lines: [...document.querySelectorAll('#legend .swatch-line')].map((e) => e.className),
    }));
    assert(!r0.chips, 'the separate level chip row is still there');
    assert(r0.rows >= 3, `${r0.rows} filter rows in the legend`);
    assert(r0.dir === 'in' && r0.attr === 'in', `default direction ${r0.dir}/${r0.attr}`);
    assert(!r0.lines.some((c) => /\bout\b/.test(c)), 'outbound line in the legend while inbound-only');
    await page.locator('#legend [data-level="2"]').click();
    const r1 = await page.evaluate(() => ({ f: [...window.__safetravel.state.filter], dim: document.querySelectorAll('#legend .lg-filter.is-dim').length }));
    assert(r1.f.length === 1 && r1.f[0] === 2 && r1.dim >= 2, `filter ${JSON.stringify(r1)}`);
    await page.locator('#legend [data-level="all"]').click();
    assert((await page.evaluate(() => window.__safetravel.state.filter.size)) === 0, '"all" did not clear the filter');
    await page.locator('#flight-hud [data-dir="both"]').click();
    const both = await page.evaluate(() => ({ d: localStorage.getItem('safetravel.flightdir'), out: !!document.querySelector('#legend .swatch-line.out') }));
    assert(both.d === 'both' && both.out, `both-ways ${JSON.stringify(both)}`);
    await page.locator('#flight-hud [data-dir="in"]').click();
    await page.locator('#legend [data-legend-min]').click();
    const min = await page.evaluate(() => ({ cls: document.querySelector('#legend').classList.contains('is-min'), st: localStorage.getItem('safetravel.legend'),
      body: getComputedStyle(document.querySelector('#legend .legend-body')).display }));
    assert(min.cls && min.st === 'min' && min.body === 'none', `collapse ${JSON.stringify(min)}`);
    await page.locator('#legend [data-legend-min]').click();
    return `${r0.rows} level rows, inbound-only default, collapse remembered`;
  });

  record('no console errors (incl. weather overlay)', consoleErrors.length === 0,
    consoleErrors.length === 0 ? '' : `${consoleErrors.length} error(s)`);

}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log('\n──── summary ────');
  console.log(`checks: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}`);
  if (consoleErrors.length) {
    console.log('\nconsole errors:');
    for (const e of consoleErrors) console.log(`  - ${e}`);
  }
  if (warnings.length) {
    console.log('\nwarnings (non-fatal):');
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exitCode = 1;
  } else {
    console.log('\nALL CHECKS PASSED');
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error(`\nsmoke test crashed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
