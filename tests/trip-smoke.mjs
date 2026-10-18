// SafeTravel TW — trip.html (出國前旅遊安全查詢) smoke test (Playwright + Chromium).
//
// Usage:   node tests/trip-smoke.mjs [pageURL]      (default http://localhost:8080/trip.html)
// Env:     SHOTS_DIR      screenshot directory            (default ./tests/shots)
//          CHROMIUM_PATH  optional chromium/headless_shell binary to use instead of the
//                         Playwright-managed browser
//          HEADED=1       run with a visible browser window
//
// This script starts nothing. Serve the site first:  python -m http.server -d web 8080
// Exit code: 0 when every check passes, 1 otherwise (a summary is printed).

import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PAGE_URL = new URL(process.argv[2] || 'http://localhost:8080/trip.html').href;
const SHOTS_DIR = path.resolve(process.env.SHOTS_DIR || path.join('tests', 'shots'));
const MAP_PATHS = '[data-testid="map"] path.ct';
const CARD = '[data-testid="card"]';
const TABLE_ROWS = '[data-testid="dest-table"] tbody tr';

const results = [];
const warnings = [];
const consoleErrors = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const visibleRows = (page) => page.locator(`${TABLE_ROWS}:not([hidden])`).count();

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: !process.env.HEADED,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  try {
    await run(page, context);
  } finally {
    await browser.close();
    finish();
  }
}

async function run(page, context) {
  await check('page loads without console errors', async () => {
    const resp = await page.goto(PAGE_URL, { waitUntil: 'load' });
    assert(resp && resp.ok(), `HTTP ${resp && resp.status()}`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
    const title = await page.title();
    assert(title.includes('出國前旅遊安全查詢'), `unexpected title "${title}"`);
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    assert(theme === 'light', `default theme should be light, got ${theme}`);
    assert(consoleErrors.length === 0, `${consoleErrors.length} console error(s): ${consoleErrors[0]}`);
    return title;
  });

  await check('map renders > 150 country paths', async () => {
    const n = await page.locator(MAP_PATHS).count();
    assert(n > 150, `only ${n} paths`);
    return `${n} paths`;
  });

  await check('switching map tabs changes fills', async () => {
    const fills = () => page.$$eval(MAP_PATHS, (els) => els.map((e) => getComputedStyle(e).fill).join('|'));
    const before = await fills();
    const kh1 = await page.$eval('[data-testid="map"] path.ct[data-iso="KH"]', (e) => getComputedStyle(e).fill);
    await page.locator('[data-testid="tab-cdc"]').click();
    const after = await fills();
    const kh2 = await page.$eval('[data-testid="map"] path.ct[data-iso="KH"]', (e) => getComputedStyle(e).fill);
    assert(await page.locator('[data-testid="tab-cdc"]').getAttribute('aria-selected') === 'true', 'tab not selected');
    assert(before !== after, 'fills unchanged');
    assert(kh1 !== kh2, `Cambodia fill unchanged (${kh1})`);
    await page.locator('[data-testid="tab-mofa"]').click();
    return `KH ${kh1} → ${kh2}`;
  });

  await check('search 柬埔寨 opens the card with 第三級 and a 第四級 area', async () => {
    const input = page.locator('[data-testid="search"]');
    await input.fill('柬埔寨');
    await page.locator('#q-list [role="option"]').first().waitFor({ timeout: 4000 });
    await input.press('Enter');
    await page.locator(CARD).waitFor({ state: 'visible', timeout: 4000 });
    const title = await page.locator('#card-title').textContent();
    assert(title.includes('柬埔寨'), `card title "${title}"`);
    const mofa = await page.locator(`${CARD} .rate-mofa .big`).textContent();
    assert(mofa.includes('第三級'), `MOFA badge "${mofa}"`);
    const areas = await page.locator(`${CARD} .area`).allTextContents();
    assert(areas.some((a) => a.includes('第四級')), 'no area with 第四級');
    const hash = await page.evaluate(() => location.hash);
    assert(hash === '#KH', `hash ${hash}`);
    // lazy full text + epidemics
    await page.locator(`${CARD} .rate-mofa > details.more summary`).click();
    await page.waitForFunction(() => document.querySelector('#card .rate-mofa > details.more .fulltext')?.dataset.loaded === '1', null, { timeout: 6000 });
    await page.waitForFunction(() => !document.querySelector('#card .epi-list')?.hasAttribute('aria-busy'), null, { timeout: 8000 });
    return `${areas.length} area(s), hash ${hash}`;
  });

  await check('deep link trip.html#JP opens the card on load', async () => {
    const p2 = await context.newPage();
    p2.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    await p2.goto(`${PAGE_URL.split('#')[0]}#JP`, { waitUntil: 'load' });
    await p2.locator(CARD).waitFor({ state: 'visible', timeout: 8000 });
    const title = await p2.locator('#card-title').textContent();
    await p2.close();
    assert(title.includes('日本'), `card title "${title}"`);
    return title;
  });

  await check('table has > 150 rows and 「需特別注意」 reduces it', async () => {
    const total = await visibleRows(page);
    assert(total > 150, `only ${total} rows`);
    await page.locator('[data-testid="preset-attention"]').click();
    const filtered = await visibleRows(page);
    assert(filtered > 0 && filtered < total, `preset gave ${filtered} of ${total}`);
    await page.locator('[data-testid="preset-attention"]').click();
    const back = await visibleRows(page);
    assert(back === total, `toggle off gave ${back}`);
    return `${total} → ${filtered}`;
  });

  await check('sorting a column sets aria-sort', async () => {
    await page.locator('[data-testid="dest-table"] th[data-key="name"] button').click();
    const s = await page.locator('[data-testid="dest-table"] th[data-key="name"]').getAttribute('aria-sort');
    assert(s === 'ascending', `aria-sort=${s}`);
    await page.locator('[data-testid="dest-table"] th[data-key="mofa"] button').click();
    return s;
  });

  await check('CSV export downloads a UTF-8 BOM file', async () => {
    await page.locator('[data-testid="preset-attention"]').click();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 6000 }),
      page.locator('[data-testid="export-csv"]').click(),
    ]);
    const file = path.join(SHOTS_DIR, 'trip-export.csv');
    await download.saveAs(file);
    await page.locator('[data-testid="preset-attention"]').click();
    const buf = readFileSync(file);
    assert(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'missing BOM');
    const text = buf.toString('utf8').slice(1);
    const lines = text.trim().split(/\r\n/);
    assert(lines[0].startsWith('"ISO","名稱","Name"'), `header ${lines[0].slice(0, 40)}`);
    assert(lines.length > 10, `${lines.length} lines`);
    return `${download.suggestedFilename()} · ${lines.length - 1} rows`;
  });

  await check('English toggle switches headings', async () => {
    await page.locator('[data-testid="lang-toggle"]').click();
    const h1 = await page.locator('h1').textContent();
    const h2 = await page.locator('#all-h').textContent();
    const lang = await page.evaluate(() => document.documentElement.lang);
    assert(lang === 'en', `lang=${lang}`);
    assert(/Pre-trip/.test(h1) && /All destinations/.test(h2), `headings "${h1}" / "${h2}"`);
    const zhLabel = await page.locator(`${CARD} .zh-label`).count();
    assert(zhLabel > 0, 'no "Chinese original" label on BOCA text');
    await page.locator('[data-testid="lang-toggle"]').click();
    const h1b = await page.locator('h1').textContent();
    assert(h1b.includes('出國前'), `back to zh: "${h1b}"`);
    return h1;
  });

  await check('phone width 390 has no horizontal overflow', async () => {
    const phone = await context.newPage();
    phone.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(`${PAGE_URL.split('#')[0]}#KH`, { waitUntil: 'load' });
    await phone.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
    const m = await phone.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      paths: document.querySelectorAll('[data-testid="map"] path.ct').length,
    }));
    await phone.close();
    assert(m.sw <= m.cw, `scrollWidth ${m.sw} > clientWidth ${m.cw}`);
    assert(m.paths > 150, `phone map has ${m.paths} paths`);
    return `${m.sw}px wide, ${m.paths} paths (110m)`;
  });

  await check('without warnings.json the CDC side and a notice still render', async () => {
    const p3 = await context.newPage();
    const errs = [];
    p3.on('pageerror', (err) => errs.push(err.message));
    await p3.route('**/data/warnings.json', (route) => route.fulfill({ status: 404, body: 'missing' }));
    await p3.goto(`${PAGE_URL.split('#')[0]}#KH`, { waitUntil: 'load' });
    await p3.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
    const r = await p3.evaluate(() => ({
      notice: document.querySelector('#notices')?.textContent || '',
      tab: document.querySelector('[data-testid="tab-cdc"]')?.getAttribute('aria-selected'),
      cdc: document.querySelector('#card .rate-cdc .big')?.textContent || '',
      rows: document.querySelectorAll('[data-testid="dest-table"] tbody tr').length,
    }));
    await p3.close();
    assert(!errs.length, `page error: ${errs[0]}`);
    assert(r.notice.includes('外交部'), 'no notice');
    assert(r.tab === 'true', 'CDC tab not selected');
    assert(/第.級/.test(r.cdc), `CDC block "${r.cdc}"`);
    assert(r.rows > 150, `${r.rows} rows`);
    return `${r.rows} rows, CDC "${r.cdc}"`;
  });

  await check('no console errors during the run', async () => {
    assert(consoleErrors.length === 0, `${consoleErrors.length}: ${consoleErrors[0]}`);
    return '';
  });
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
  console.error(`\ntrip smoke test crashed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
