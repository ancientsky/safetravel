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
  await check('outbreak route watch toggles the map layer', async () => {
    await page.locator('[data-testid="watch-toggle"]').click();
    await page.locator('[data-testid="watch-menu"] .wt-switch').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.watch-layer:not([hidden]) .wt-arc').length > 10, null, { timeout: 8000, polling: 250 });
    const arcs = await page.locator('.wt-arc').count();
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
