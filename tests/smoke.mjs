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
