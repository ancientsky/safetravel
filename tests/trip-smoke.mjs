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
const WX = '[data-testid="weather"]';
const WX_CITY = `${WX} [data-testid="wx-city"]:not([hidden])`;
const CJK = /[\u3400-\u9fff]/;

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
// visible city cards (a card or its region group may be hidden)
const wxCities = (page) => page.$$eval(`${WX} [data-testid="wx-city"]`, (els) => els.filter((e) => e.offsetParent !== null).length);

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

  await check('weather section renders 80 city cards with CWA provenance', async () => {
    const n = await wxCities(page);
    assert(n === 80, `${n} city cards`);
    const sub = await page.locator(`${WX} .wx-sub`).textContent();
    assert(/中央氣象署 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 發布/.test(sub), `provenance "${sub}"`);
    assert(sub.includes('臺灣日期'), 'no Taiwan-date note');
    const stamps = await page.locator('#stamps').textContent();
    assert(stamps.includes('氣象署預報'), `stamps "${stamps}"`);
    const foot = await page.locator('footer a.foot-cwa').getAttribute('href');
    assert(foot.startsWith('https://opendata.cwa.gov.tw/'), `footer href ${foot}`);
    const nav = await page.locator('.jump a[href="#weather"]').count();
    assert(nav === 1, 'no #weather link in the jump nav');
    const named = await page.$$eval(`${WX} .wx-days svg.wxi`, (els) => els.every((e) => e.getAttribute('role') === 'img' && e.getAttribute('aria-label')));
    assert(named, 'a day icon has no accessible name');
    return `${n} cards`;
  });

  await check('weather region tabs filter (歐洲、非洲 → 22) and follow arrow keys', async () => {
    await page.locator('[data-testid="wx-tab-europe"]').click();
    const eu = await wxCities(page);
    const label = await page.locator('[data-testid="wx-tab-europe"]').textContent();
    assert(label.includes('歐洲、非洲') && label.includes('22'), `tab "${label}"`);
    assert(eu === 22, `${eu} cards for 歐洲、非洲`);
    await page.locator('[data-testid="wx-tab-europe"]').press('Home');
    const focused = await page.evaluate(() => document.activeElement?.dataset.testid);
    assert(focused === 'wx-tab-all', `Home focused ${focused}`);
    await page.keyboard.press('ArrowRight');
    const asia = await wxCities(page);
    const sel = await page.locator('[data-testid="wx-tab-asia"]').getAttribute('aria-selected');
    assert(sel === 'true' && asia === 24, `ArrowRight → asia selected=${sel}, ${asia} cards`);
    const panel = await page.locator('#wx-panel').getAttribute('aria-labelledby');
    assert(panel === 'wx-tab-asia', `tabpanel labelled by ${panel}`);
    await page.locator('[data-testid="wx-tab-all"]').click();
    return `europe ${eu}, asia ${asia}`;
  });

  await check('weather text filter matches city, country and ISO', async () => {
    const f = page.locator('[data-testid="wx-filter"]');
    await f.fill('美國');
    const us = await wxCities(page);
    await f.fill('jp');
    const jp = await wxCities(page);
    await f.fill('London');
    const ldn = await wxCities(page);
    await f.fill('zzzz');
    const none = await wxCities(page);
    const empty = await page.locator(`${WX} .wx-empty`).isVisible();
    await f.fill('');
    const all = await wxCities(page);
    assert(us === 9, `美國 → ${us}`);
    assert(jp === 2, `jp → ${jp}`);
    assert(ldn === 1, `London → ${ldn}`);
    assert(none === 0 && empty, `zzzz → ${none}, empty message ${empty}`);
    assert(all === 80, `cleared → ${all}`);
    return `美國 ${us}, jp ${jp}, London ${ldn}`;
  });

  await check('°F toggle converts temperatures and is remembered', async () => {
    const hi = page.locator(`${WX} .wx-city[data-iso="JP"] .wx-now-hi`).first();
    const c = parseInt((await hi.textContent()).replace(/\D+/g, ''), 10);
    await page.locator('[data-testid="wx-unit-f"]').click();
    const f = parseInt((await hi.textContent()).replace(/\D+/g, ''), 10);
    const stored = await page.evaluate(() => localStorage.getItem('safetravel.trip.unit'));
    const pressed = await page.locator('[data-testid="wx-unit-f"]').getAttribute('aria-pressed');
    await page.locator('[data-testid="wx-unit-c"]').click();
    const back = parseInt((await hi.textContent()).replace(/\D+/g, ''), 10);
    assert(f === Math.round((c * 9) / 5 + 32), `${c}°C → ${f}°F`);
    assert(stored === 'F' && pressed === 'true', `stored ${stored}, aria-pressed ${pressed}`);
    assert(back === c, `back to °C gave ${back}`);
    return `Tokyo ${c}°C = ${f}°F`;
  });

  await check('activating a city card opens its destination card with local weather', async () => {
    await page.locator(`${WX} .wx-city[data-iso="JP"] .wx-open`).first().focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash === '#JP', null, { timeout: 4000 });
    const title = await page.locator('#card-title').textContent();
    assert(title.includes('日本'), `card title "${title}"`);
    const block = page.locator(`${CARD} [data-testid="card-weather"]`);
    await block.waitFor({ state: 'visible', timeout: 4000 });
    const head = await block.locator('h3').textContent();
    const rows = await block.locator('tbody tr').allTextContents();
    assert(head.includes('當地天氣預報'), `block heading "${head}"`);
    assert(rows.length === 2 && rows[0].includes('東京') && rows[1].includes('大阪'), `rows ${rows.length}: ${rows.map((r) => r.slice(0, 4))}`);
    // a pointer click anywhere on a card (here: over its 7-day strip) opens it too
    const fr = page.locator(`${WX} .wx-city[data-iso="FR"]`);
    const box = await fr.boundingBox();
    await fr.click({ position: { x: box.width / 2, y: box.height - 40 } });
    await page.waitForFunction(() => location.hash === '#FR', null, { timeout: 4000 });
    const frRows = await page.locator(`${CARD} [data-testid="card-weather"] tbody tr`).count();
    assert(frRows === 1, `France block has ${frRows} rows`);
    // a country without a CWA city gets no block
    await page.evaluate(() => { location.hash = '#KH'; });
    await page.waitForFunction(() => document.querySelector('#card')?.dataset.iso === 'KH', null, { timeout: 4000 });
    const kh = await page.locator(`${CARD} [data-testid="card-weather"]`).isVisible();
    assert(!kh, 'Cambodia shows a weather block');
    return `JP: ${rows.length} cities`;
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

  await check('English mode shows CWA English phrases in the weather section', async () => {
    await page.locator('[data-testid="lang-toggle"]').click();
    const r = await page.evaluate(() => ({
      phrases: [...document.querySelectorAll('[data-testid="weather"] .wx-now-ph')].map((e) => e.textContent),
      labels: [...document.querySelectorAll('[data-testid="weather"] .wx-days svg.wxi')].slice(0, 20).map((e) => e.getAttribute('aria-label')),
      wd: document.querySelector('[data-testid="weather"] .wx-dw')?.textContent,
      sub: document.querySelector('[data-testid="weather"] .wx-sub')?.textContent || '',
      tab: document.querySelector('[data-testid="wx-tab-europe"]')?.textContent || '',
      h2: document.querySelector('#wx-h')?.textContent,
    }));
    await page.locator('[data-testid="lang-toggle"]').click();
    assert(r.h2 === 'World city weather', `heading "${r.h2}"`);
    assert(r.phrases.length === 80 && r.phrases.every((p) => p && !CJK.test(p)), `phrases ${r.phrases.slice(0, 3)}`);
    assert(r.phrases.some((p) => /Rain|Cloudy|Overcast|Sunny|Showers/.test(p)), 'no known English phrase');
    assert(r.labels.every((l) => l && !CJK.test(l)), `icon labels ${r.labels.slice(0, 3)}`);
    assert(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/.test(r.wd), `weekday "${r.wd}"`);
    assert(/Issued by CWA/.test(r.sub) && /Taiwan dates/.test(r.sub), `sub "${r.sub}"`);
    assert(r.tab.includes('Europe & Africa'), `tab "${r.tab}"`);
    return r.phrases.slice(0, 3).join(', ');
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

  await check('phone width 390: weather section and a local-weather card do not overflow', async () => {
    const phone = await context.newPage();
    phone.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(`${PAGE_URL.split('#')[0]}#US`, { waitUntil: 'load' });
    await phone.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
    await phone.locator(WX).scrollIntoViewIfNeeded();
    const m = await phone.evaluate(() => {
      const strip = document.querySelector('[data-testid="wx-city"] .wx-days');
      return {
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        cards: document.querySelectorAll('[data-testid="wx-city"]').length,
        local: document.querySelectorAll('#card [data-testid="card-weather"] tbody tr').length,
        strip: strip ? strip.scrollWidth - strip.clientWidth : -1,
      };
    });
    await phone.close();
    assert(m.sw <= m.cw, `scrollWidth ${m.sw} > clientWidth ${m.cw}`);
    assert(m.cards === 80, `${m.cards} city cards`);
    assert(m.local === 9, `US card lists ${m.local} cities`);
    assert(m.strip === 0, `7-day strip overflows by ${m.strip}px`);
    return `${m.sw}px wide, US block ${m.local} cities`;
  });

  await check('without weather.json the section shows a notice and the page still works', async () => {
    const p4 = await context.newPage();
    const errs = [];
    p4.on('pageerror', (err) => errs.push(err.message));
    // the browser itself logs the 404 resource load; anything else is ours
    p4.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errs.push(msg.text()); });
    await p4.route('**/data/weather.json', (route) => route.fulfill({ status: 404, body: 'missing' }));
    await p4.goto(`${PAGE_URL.split('#')[0]}#JP`, { waitUntil: 'load' });
    await p4.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
    const r = await p4.evaluate(() => ({
      failed: document.querySelector('[data-testid="wx-failed"]')?.textContent || '',
      cards: document.querySelectorAll('[data-testid="wx-city"]').length,
      tools: document.querySelector('.wx-tools')?.hidden,
      block: !!document.querySelector('#card [data-testid="card-weather"]:not([hidden])'),
      title: document.querySelector('#card-title')?.textContent || '',
      rows: document.querySelectorAll('[data-testid="dest-table"] tbody tr').length,
      paths: document.querySelectorAll('[data-testid="map"] path.ct').length,
      stamps: document.querySelector('#stamps')?.textContent || '',
    }));
    await p4.close();
    assert(!errs.length, `error: ${errs[0]}`);
    assert(r.failed.includes('無法載入'), `notice "${r.failed}"`);
    assert(r.cards === 0 && r.tools === true, `${r.cards} cards, tools hidden ${r.tools}`);
    assert(!r.block && r.title.includes('日本'), `card "${r.title}", weather block ${r.block}`);
    assert(r.rows > 150 && r.paths > 150, `${r.rows} rows, ${r.paths} paths`);
    assert(r.stamps.includes('氣象署預報') && r.stamps.includes('未知'), `stamps "${r.stamps}"`);
    return 'notice shown, table + map + card fine';
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
