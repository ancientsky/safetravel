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

// ---- phone layout (screens up to 760 px): short lists with "show all", sticky section chips, back to top ----
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const PHONE_FIRST = { cl: 6, wx: 6, t: 8 }; // items before "show all": trip-clinics.js, trip-weather.js, trip-table.js
const LISTS = [
  { key: 'cl', item: '[data-testid="cl-card"]', btn: '[data-testid="cl-more"]', host: '#cl-list' },
  { key: 'wx', item: '[data-testid="wx-city"]:not([hidden])', btn: '[data-testid="wx-more"]', host: '#wx-panel' },
  { key: 't', item: '#dest-table tbody tr:not([hidden])', btn: '[data-testid="t-more"]', host: '#dest-table' },
];
/** A fresh phone-sized page on trip.html (`tail` = query + hash), loaded with its clinics and weather in. */
async function openPhone(context, tail = '', opts = {}) {
  const ctx = await context.browser().newContext({ ...PHONE, ...opts });
  const p = await ctx.newPage();
  p.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  p.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  await p.goto(`${PAGE_URL.split('#')[0].split('?')[0]}${tail}`, { waitUntil: 'load' });
  await p.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
  await p.waitForSelector('[data-testid="cl-card"]', { state: 'attached', timeout: 15000 });
  return { ctx, p };
}
/** [rendered (laid out), all] elements matching `sel`. */
const shownOf = (p, sel) => p.$$eval(sel, (els) => [els.filter((e) => e.offsetParent !== null).length, els.length]);
const isShown = (p, sel) => p.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none');
const scrollY = (p) => p.evaluate(() => Math.round(window.scrollY));
const cardOpen = (p) => p.$eval('#card', (c) => !c.hidden);
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

  await check('map tabs: arrow keys cycle through 3 tabs; weather tab shows 80 city markers', async () => {
    await page.locator('[data-testid="tab-mofa"]').focus();
    const seen = [];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ArrowRight');
      seen.push(await page.evaluate(() => document.activeElement?.dataset.tab));
    }
    assert(seen.join() === 'cdc,wx,mofa', `ArrowRight order ${seen}`);
    await page.keyboard.press('End');
    const r = await page.evaluate(() => ({
      tab: document.querySelector('[data-testid="tab-wx"]').getAttribute('aria-selected'),
      focused: document.activeElement?.dataset.tab,
      markers: document.querySelectorAll('[data-testid="wx-marker"]').length,
      shown: [...document.querySelectorAll('[data-testid="wx-marker"]')].filter((e) => e.getBoundingClientRect().width > 0).length,
      full: document.querySelectorAll('[data-testid="wx-marker"].is-full').length,
      named: [...document.querySelectorAll('[data-testid="wx-marker"]')].every((e) => /°/.test(e.getAttribute('aria-label') || '')),
      legend: document.querySelector('#legend')?.textContent || '',
      bar: !document.querySelector('[data-testid="wxm-bar"]').hidden,
      role: document.querySelector('#tmap').getAttribute('role'),
    }));
    assert(r.tab === 'true' && r.focused === 'wx', `End → selected ${r.tab}, focus ${r.focused}`);
    assert(r.markers === 80 && r.shown === 80, `${r.markers} markers, ${r.shown} shown`);
    assert(r.full > 10 && r.full < 80, `${r.full} full markers at world zoom`);
    assert(r.named, 'a marker lacks an accessible name with a temperature');
    assert(r.legend.includes('最高溫') && r.legend.includes('發布') && r.legend.includes('臺灣日期'), `legend "${r.legend.slice(0, 60)}"`);
    assert(r.bar && r.role === 'group', `day bar ${r.bar}, svg role ${r.role}`);
    return `${r.markers} markers, ${r.full} full`;
  });

  await check('weather map: day selector, °F and tooltip update the Tokyo marker', async () => {
    const tokyo = page.locator('[data-testid="wx-marker"][data-city="47662"]');
    const exp = await page.evaluate(async () => {
      const d = await (await fetch('data/weather.json')).json();
      return d.cities.find((c) => c.id === '47662').days.map((x) => x.max);
    });
    const temp = async () => (await tokyo.locator('.wxm-t').textContent()).replace('−', '-');
    const d1 = await temp();
    await page.locator('[data-testid="wxm-day-1"]').click();
    const d2 = await temp();
    const label2 = await tokyo.getAttribute('aria-label');
    assert(d1 === `${exp[0]}°` && d2 === `${exp[1]}°`, `day 1 ${d1} / day 2 ${d2}, expected ${exp[0]}° / ${exp[1]}°`);
    assert(label2.startsWith('東京') && label2.includes(`${exp[1]}°`), `label "${label2}"`);
    await page.locator('[data-testid="wx-unit-f"]').click();
    const f = await temp();
    await page.locator('[data-testid="wx-unit-c"]').click();
    assert(f === `${Math.round((exp[1] * 9) / 5 + 32)}°`, `°F marker ${f}`);
    await page.locator('[data-testid="wxm-day-0"]').click();
    await page.locator('#map-sec').scrollIntoViewIfNeeded();
    const box = await tokyo.locator('.wxm-dot').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('#tip:not([hidden]) .wxt-d').first().waitFor({ timeout: 3000 });
    const tip = await page.evaluate(() => ({ n: document.querySelectorAll('#tip .wxt-d').length, text: document.querySelector('#tip').textContent }));
    await page.mouse.move(2, 2);
    assert(tip.n === 7 && tip.text.includes('東京') && tip.text.includes('Tokyo'), `tooltip ${tip.n} days "${tip.text.slice(0, 30)}"`);
    return `day 1 ${d1}, day 2 ${d2}, ${f}`;
  });

  await check('weather map: keyboard and click on a marker open the destination card', async () => {
    const tokyo = page.locator('[data-testid="wx-marker"][data-city="47662"]');
    await tokyo.focus();
    await page.keyboard.press('ArrowRight');
    const moved = await page.evaluate(() => document.activeElement?.dataset.city);
    assert(moved && moved !== '47662', `arrow key focus ${moved}`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash === '#JP', null, { timeout: 4000 });
    await page.locator('#map-sec').scrollIntoViewIfNeeded();
    const london = page.locator('[data-testid="wx-marker"][data-city="3770"] .wxm-dot');
    const b = await london.boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForFunction(() => location.hash === '#GB', null, { timeout: 4000 });
    const title = await page.locator('#card-title').textContent();
    await page.locator('[data-testid="tab-mofa"]').click();
    const hidden = await page.evaluate(() => getComputedStyle(document.querySelector('.wxm')).display === 'none');
    assert(title.includes('英國'), `card "${title}"`);
    assert(hidden, 'markers still shown on the warning tab');
    return `#JP then #GB (${title})`;
  });

  await check('weather map on a 390 px phone: no overflow, tap shows the forecast, second tap opens the card', async () => {
    const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const phone = await ctx.newPage();
    const errs = [];
    phone.on('pageerror', (err) => errs.push(err.message));
    phone.on('console', (msg) => { if (msg.type() === 'error') errs.push(msg.text()); });
    await phone.goto(PAGE_URL.split('#')[0], { waitUntil: 'load' });
    await phone.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
    await phone.locator('[data-testid="tab-wx"]').tap();
    await phone.locator('#map-sec').scrollIntoViewIfNeeded();
    const m = await phone.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      markers: [...document.querySelectorAll('[data-testid="wx-marker"]')].filter((e) => e.getBoundingClientRect().width > 0).length,
    }));
    const dot = await phone.locator('[data-testid="wx-marker"][data-city="47662"] .wxm-dot').boundingBox();
    await phone.touchscreen.tap(dot.x + dot.width / 2, dot.y + dot.height / 2);
    await phone.locator('#tip:not([hidden]) .wxt-d').first().waitFor({ timeout: 3000 });
    const hash1 = await phone.evaluate(() => location.hash);
    await phone.touchscreen.tap(dot.x + dot.width / 2, dot.y + dot.height / 2);
    await phone.waitForFunction(() => location.hash === '#JP', null, { timeout: 4000 });
    await ctx.close();
    assert(m.sw <= m.cw, `scrollWidth ${m.sw} > clientWidth ${m.cw}`);
    assert(m.markers === 80, `${m.markers} markers`);
    assert(hash1 === '', `first tap navigated to ${hash1}`);
    assert(!errs.length, `error: ${errs[0]}`);
    return `${m.sw}px wide, ${m.markers} markers`;
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
    await p4.locator('[data-testid="tab-wx"]').click();
    const r = await p4.evaluate(() => ({
      legend: document.querySelector('#legend')?.textContent || '',
      markers: document.querySelectorAll('[data-testid="wx-marker"]').length,
      bar: document.querySelector('[data-testid="wxm-bar"]').hidden,
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
    assert(r.legend.includes('無法載入') && r.markers === 0 && r.bar, `weather tab: legend "${r.legend}", ${r.markers} markers`);
    return 'notice shown, table + map + card fine, weather tab explains';
  });

  await check('kiosk self-reload: new site code / new data reload only after 5 min without input', async () => {
    const pr = await context.newPage();
    const errs = [];
    pr.on('pageerror', (e) => errs.push(e.message));
    let code = 'aaaa1111';
    let gen = '2026-01-01T11:00:00+08:00';
    await pr.route('**/version.json*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ code }) }));
    await pr.route('**/data/meta.json*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ generated_at: gen }) }));
    await pr.clock.install();
    await pr.goto(`${PAGE_URL.split('#')[0]}?refreshEvery=1#JP`, { waitUntil: 'load' });
    await pr.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
    await pr.evaluate(() => { window.__marker = 1; });
    await pr.waitForTimeout(2500);
    assert(await pr.evaluate(() => !document.documentElement.dataset.reloadPending), 'reload pending without any change');
    code = 'bbbb2222';
    await pr.waitForFunction(() => document.documentElement.dataset.reloadPending === 'code', null, { timeout: 8000 });
    await pr.mouse.move(40, 40); // someone is using the page
    await pr.clock.fastForward('04:00');
    await pr.waitForTimeout(1500);
    assert(await pr.evaluate(() => window.__marker === 1), 'reloaded within 5 min of input');
    const reloaded = pr.waitForEvent('load', { timeout: 15000 });
    await pr.clock.fastForward('02:00');
    await reloaded;
    await pr.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
    const after = await pr.evaluate(() => ({ marker: window.__marker, hash: location.hash, title: document.querySelector('#card-title')?.textContent || '' }));
    assert(after.marker === undefined && after.hash === '#JP' && after.title.includes('日本'), `after reload: ${JSON.stringify(after)}`);
    await pr.waitForTimeout(2500); // let the reloaded page read its new baseline first
    gen = '2026-01-01T21:00:00+08:00'; // a data refresh is detected too
    await pr.waitForFunction(() => document.documentElement.dataset.reloadPending === 'data', null, { timeout: 8000 });
    await pr.close();
    assert(!errs.length, errs[0]);
    return 'code change: waits for 5 idle minutes, reloads with #JP kept; data change detected';
  });

  await check('search by airport / city: NRT and 曼谷 open Japan / Thailand', async () => {
    const pr = await context.newPage();
    await pr.goto(PAGE_URL.split('#')[0], { waitUntil: 'load' });
    await pr.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
    const input = pr.locator('input[role="combobox"]').first();
    const pick = async (q, want) => {
      await input.fill(q);
      await pr.waitForFunction(() => document.querySelector('[role="listbox"] .opt-place'), null, { timeout: 8000 });
      const first = await pr.$eval('[role="listbox"] [role="option"]', (l) => l.textContent.replace(/\s+/g, ' ').trim());
      await input.press('Enter');
      await pr.waitForFunction((h) => location.hash === h, want, { timeout: 5000 });
      return first;
    };
    const a = await pick('NRT', '#JP');
    const b = await pick('曼谷', '#TH');
    await pr.close();
    return `NRT → ${a}; 曼谷 → ${b}`;
  });

  await check('search ranking: everyday names (uk, korea, america) and "jap" / "ind" list the country first; NRT still the airport', async () => {
    const pr = await context.newPage();
    await pr.goto(`${PAGE_URL.split('#')[0]}?lang=en`, { waitUntil: 'load' });
    await pr.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
    const input = pr.locator('input[role="combobox"]').first();
    await input.fill('NRT');
    await pr.waitForFunction(() => document.querySelector('[role="listbox"] .opt-place'), null, { timeout: 8000 });
    const first = async (q) => {
      await input.fill(q);
      await pr.waitForFunction(() => document.querySelector('[role="listbox"] [role="option"]'), null, { timeout: 5000 });
      return pr.$eval('[role="listbox"] [role="option"]', (l) => ({
        place: l.classList.contains('opt-place'), name: l.querySelector('.opt-name').textContent.trim(),
      }));
    };
    const want = { uk: 'United Kingdom', korea: 'Korea', america: 'United States', jap: 'Japan', ind: 'Indonesia' };
    const got = [];
    for (const [q, name] of Object.entries(want)) {
      const r = await first(q);
      assert(!r.place && r.name.includes(name), `"${q}" → ${r.place ? 'place ' : ''}${r.name}`);
      got.push(`${q} → ${r.name}`);
    }
    const nrt = await first('NRT');
    assert(nrt.place && /Narita/.test(nrt.name), `NRT → ${nrt.name}`);
    await pr.close();
    return `${got.join('; ')}; NRT → ${nrt.name}`;
  });

  await check('phone 390 at the largest text: the header stays inside the screen in both languages', async () => {
    const out = [];
    for (const lang of ['zh', 'en']) {
      const { ctx, p } = await openPhone(context, `?lang=${lang}&text=xl`);
      const m = await p.evaluate(() => ({
        doc: document.documentElement.scrollWidth, vw: window.innerWidth,
        right: Math.round(document.querySelector('.toggles').getBoundingClientRect().right),
        back: Math.round(document.querySelector('.back').getBoundingClientRect().width),
      }));
      assert(m.doc <= m.vw && m.right <= m.vw, `${lang}: page ${m.doc}px wide, buttons end at ${m.right}px on ${m.vw}px`);
      assert(m.back >= 44, `${lang}: back link ${m.back}px`);
      out.push(`${lang} ${m.doc}px, back link ${m.back}px`);
      await ctx.close();
    }
    return out.join('; ');
  });

  await check('malaria medicine in the card: unofficial timing table where CDC asks for a doctor\'s assessment, link to the calculator, absent elsewhere', async () => {
    const pr = await context.newPage();
    const open = async (q, iso) => {
      await pr.goto(`${PAGE_URL.split('#')[0].split('?')[0]}${q}#${iso}`, { waitUntil: 'load' });
      await pr.reload({ waitUntil: 'load' });
      await pr.waitForSelector('[data-testid="med"] .med-place', { timeout: 15000 });
      return pr.evaluate(() => {
        const m = document.querySelector('[data-testid="med-malaria"]');
        if (!m) return null;
        return {
          tag: m.querySelector('.mal-tag').textContent, rows: [...m.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim())),
          out: [...m.querySelectorAll('tbody tr.is-out th span')].map((x) => x.textContent), href: m.querySelector('[data-testid="med-malaria-link"]').getAttribute('href'),
          disc: m.querySelector('.mal-disc').textContent, src: m.querySelector('.mal-disc a').href, after: m.previousElementSibling?.querySelector('[data-testid="med-vax"]') != null,
        };
      });
    };
    const th = await open('?lang=zh', 'TH');
    assert(th && th.tag === '非官方' && th.rows.length === 3 && th.after, `Thailand block: ${JSON.stringify(th)}`);
    assert(th.rows[0].slice(1, 4).join('|') === '每天一次|抵達前 1–2 天|再吃 7 天', `Malarone row: ${th.rows[0]}`);
    assert(th.rows[1].slice(1, 4).join('|') === '每天一次|抵達前 1–2 天|再吃 4 週', `doxycycline row: ${th.rows[1]}`);
    assert(th.rows[2].slice(1, 4).join('|') === '每週一次（同一天）|抵達前 2–3 週|再吃 4 週', `mefloquine row: ${th.rows[2]}`);
    assert(th.out.join() === '美爾奎寧' && /抗藥/.test(th.rows[2][4]), `mefloquine marked for Thailand: ${th.out} / ${th.rows[2][4]}`);
    assert(th.href === 'malaria.html?c=TH' && /不是疾管署的官方服務/.test(th.disc) && /醫師評估後處方/.test(th.disc) && /cdc\.gov\.tw/.test(th.src), `link and notice: ${th.href} / ${th.disc}`);
    const ke = await open('?lang=en', 'KE');
    assert(ke && ke.tag === 'Unofficial' && !ke.out.length && ke.href === 'malaria.html?c=KE&lang=en' && /not a Taiwan CDC service/.test(ke.disc), `Kenya (en): ${JSON.stringify(ke)}`);
    const jp = await open('?lang=zh', 'JP');
    const kr = await open('?lang=zh', 'KR');
    assert(jp === null && kr === null, 'no block for Japan (no risk) or South Korea (mosquito protection only)');
    // the link opens the calculator with the country filled in and its own unofficial notice
    await open('?lang=zh', 'TH');
    await Promise.all([pr.waitForURL(/malaria\.html\?c=TH/, { timeout: 10000 }), pr.click('[data-testid="med-malaria-link"]')]);
    await pr.waitForFunction(() => /泰國/.test(document.querySelector('select')?.selectedOptions?.[0]?.textContent || ''), null, { timeout: 10000 });
    const banner = await pr.evaluate(() => document.body.textContent.includes('不是疾管署的官方服務'));
    assert(banner, 'the calculator says it is not an official service');
    await pr.close();
    return `TH: 3 drugs, mefloquine marked resistant, → ${th.href}; KE (en) → ${ke.href}; JP, KR: none`;
  });

  await check('travel prescription in the card: vaccines, traveller-group notes on demand, emergency tel links', async () => {
    const pr = await context.newPage();
    await pr.addInitScript(() => { try { localStorage.removeItem('safetravel.trip.groups'); } catch {} });
    await pr.goto(`${PAGE_URL.split('#')[0]}#TH`, { waitUntil: 'load' });
    await pr.waitForSelector('[data-testid="med"] [data-testid="med-vax"]', { timeout: 15000 });
    const names = await pr.$$eval('[data-testid="med-vax"] .med-vax-name', (els) => els.map((e) => e.textContent));
    assert(names.length >= 5 && names.some((n) => n.includes('黃熱病疫苗')), `vaccines: ${names.join('、')}`);
    const yf = pr.locator('[data-testid="med-vax"]', { hasText: '黃熱病疫苗' });
    await yf.locator('summary').click();
    const hiddenNote = await yf.locator('.med-ln[data-g="pregnancy"]').first().isVisible();
    assert(!hiddenNote, 'pregnancy note visible before the group was picked');
    await pr.click('[data-testid="med-group-pregnancy"]');
    assert(await yf.locator('.med-ln[data-g="pregnancy"]').first().isVisible(), 'pregnancy note did not appear');
    const stored = await pr.evaluate(() => localStorage.getItem('safetravel.trip.groups'));
    assert(stored && stored.includes('pregnancy'), `group not remembered (${stored})`);
    const tel = await pr.$$eval('[data-testid="med"] a.med-tel', (as) => as.map((a) => a.getAttribute('href')));
    assert(tel.includes('tel:+66816664006') && tel.includes('tel:0800085095'), `tel links: ${tel.join(' ')}`);
    const chips = await pr.$$eval('.med-dis-vector .med-chips li', (els) => els.map((e) => e.textContent));
    assert(chips.some((c) => c.includes('登革熱')), `vector-borne: ${chips.join('、')}`);
    await pr.close();
    return `${names.length} vaccines; tel ${tel.length}`;
  });

  await check('travel prescription: a country split by CDC (Portugal) offers its island areas', async () => {
    const pr = await context.newPage();
    await pr.goto(`${PAGE_URL.split('#')[0]}#PT`, { waitUntil: 'load' });
    await pr.waitForSelector('[data-testid="med"] .med-places .med-pbtn', { timeout: 15000 });
    const tabs = await pr.$$eval('.med-places .med-pbtn', (bs) => bs.map((b) => b.textContent));
    assert(tabs.length === 3 && tabs.some((x) => x.includes('亞速')), `areas: ${tabs.join(' / ')}`);
    await pr.close();
    return tabs.join(' / ');
  });

  await check('clinic finder: 33 clinics with week grids; city and M痘 filters; card button jumps here', async () => {
    const pr = await context.newPage();
    await pr.goto(`${PAGE_URL.split('#')[0]}#JP`, { waitUntil: 'load' });
    await pr.waitForSelector('[data-testid="cl-card"]', { timeout: 15000 });
    const all = await pr.locator('[data-testid="cl-card"]').count();
    assert(all >= 30, `only ${all} clinics`);
    const cells = await pr.locator('[data-testid="cl-card"]').first().locator('.cl-wk-x').count();
    assert(cells === 21, `week grid has ${cells} cells`);
    await pr.selectOption('[data-testid="cl-city"]', '臺北市');
    const tp = await pr.locator('[data-testid="cl-card"]').count();
    assert(tp > 0 && tp < all, `臺北市 → ${tp}`);
    const cities = await pr.$$eval('[data-testid="cl-card"] .cl-meta span:first-child', (els) => [...new Set(els.map((e) => e.textContent))]);
    assert(cities.length === 1 && cities[0] === '臺北市', `cities after filter: ${cities}`);
    await pr.selectOption('[data-testid="cl-city"]', '');
    await pr.click('[data-testid="cl-mpox"]');
    const mp = await pr.locator('[data-testid="cl-card"]').count();
    const badges = await pr.locator('[data-testid="cl-card"] .cl-b-mpox').count();
    assert(mp > 0 && mp < all && badges === mp, `M痘 filter → ${mp} (badges ${badges})`);
    await pr.click('[data-testid="cl-mpox"]');
    const tel = await pr.locator('[data-testid="cl-card"] a[href^="tel:"]').count();
    assert(tel >= 30, `${tel} call buttons`);
    await pr.waitForSelector('[data-testid="med-find-clinic"]', { timeout: 15000 });
    await pr.click('[data-testid="med-find-clinic"]');
    await pr.waitForFunction(() => document.activeElement?.id === 'cl-h', null, { timeout: 5000 });
    await pr.close();
    return `${all} clinics, 臺北市 ${tp}, M痘 ${mp}`;
  });

  await check('phone width 390: travel prescription and clinic list do not overflow', async () => {
    const ctx = await context.browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const pr = await ctx.newPage();
    await pr.goto(`${PAGE_URL.split('#')[0]}#TH`, { waitUntil: 'load' });
    await pr.waitForSelector('[data-testid="med-vax"]', { timeout: 15000 });
    await pr.waitForSelector('[data-testid="cl-card"]', { timeout: 15000 });
    await pr.locator('[data-testid="med-vax"]').first().locator('summary').click();
    const over = await pr.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const mapHidden = await pr.$eval('.cl-map', (m) => m.hidden);
    await ctx.close();
    assert(over <= 0, `overflow ${over}px`);
    assert(mapHidden, 'locator map should stay hidden on phones');
    return 'no overflow';
  });

  await check('phone 390: #JP page is under 25,000 px tall in both languages, without horizontal overflow', async () => {
    const out = [];
    for (const lang of ['zh', 'en']) {
      const { ctx, p } = await openPhone(context, `?lang=${lang}#JP`);
      await p.waitForSelector('[data-testid="med"]', { timeout: 15000 });
      await p.waitForTimeout(800); // lazy parts of the card
      const m = await p.evaluate(() => ({
        h: document.documentElement.scrollHeight, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        title: document.querySelector('#card-title')?.textContent || '',
      }));
      await ctx.close();
      assert(/日本|Japan/.test(m.title), `${lang}: card "${m.title}"`);
      assert(m.h < 25000, `${lang}: page is ${m.h}px tall`);
      assert(m.sw <= m.cw, `${lang}: scrollWidth ${m.sw} > clientWidth ${m.cw}`);
      out.push(`${lang} ${m.h}px`);
    }
    return out.join(', ');
  });

  await check('phone 390: clinics, weather and destinations show their first items and a “show all (n)” button that expands and collapses', async () => {
    const { ctx, p } = await openPhone(context, '?lang=zh');
    const out = [];
    for (const L of LISTS) {
      const n = PHONE_FIRST[L.key];
      const [shown, total] = await shownOf(p, L.item);
      assert(total > n && shown === n, `${L.key}: ${shown} of ${total} shown, expected ${n}`);
      const btn = p.locator(L.btn);
      assert(await isShown(p, L.btn), `${L.key}: no button`);
      const label = (await btn.textContent()).trim();
      assert(label === `顯示全部（${total}）`, `${L.key}: button "${label}", ${total} items`);
      assert(await btn.getAttribute('aria-expanded') === 'false', `${L.key}: aria-expanded before`);
      const box = await btn.boundingBox();
      assert(box.width >= 340 && box.height >= 44, `${L.key}: button ${Math.round(box.width)}×${Math.round(box.height)}`);
      await btn.tap();
      const [all] = await shownOf(p, L.item);
      const open = (await btn.textContent()).trim();
      assert(all === total, `${L.key}: ${all} of ${total} after “show all”`);
      assert(open === '收合' && await btn.getAttribute('aria-expanded') === 'true', `${L.key}: expanded button "${open}"`);
      await btn.scrollIntoViewIfNeeded();
      await btn.tap();
      const [back] = await shownOf(p, L.item);
      const top = await p.$eval(L.host, (e) => Math.round(e.getBoundingClientRect().top));
      const bar = await p.$eval('.jump', (e) => Math.round(e.getBoundingClientRect().bottom));
      assert(back === n, `${L.key}: ${back} shown after collapsing`);
      assert(top >= bar && top < bar + 60, `${L.key}: list top at ${top}px after collapsing (chip row ends at ${bar}px)`);
      out.push(`${L.key} ${n}/${total}`);
    }
    // English label; the expanded state survives a language switch
    await p.locator('[data-testid="wx-more"]').tap();
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.locator('[data-testid="lang-toggle"]').tap();
    const en = await p.evaluate(() => ['cl-more', 'wx-more', 't-more'].map((id) => document.querySelector(`[data-testid="${id}"]`).textContent.trim()));
    const [wxAll, wxTotal] = await shownOf(p, LISTS[1].item);
    await ctx.close();
    assert(/^Show all \(\d+\)$/.test(en[0]) && en[1] === 'Show fewer' && en[2] === 'Show all (248)', `English labels: ${en.join(' | ')}`);
    assert(wxAll === wxTotal, `weather collapsed again by the language switch (${wxAll}/${wxTotal})`);
    return out.join(', ');
  });

  await check('phone 390: filters, search and sorting work on the whole list; a match after the first items stays reachable', async () => {
    const { ctx, p } = await openPhone(context, '?lang=zh');
    // weather: London is far beyond the first 6 cities
    const london = `${WX} .wx-city[data-iso="GB"]`;
    assert(!(await p.$eval(london, (e) => e.offsetParent !== null)), 'London shown before filtering');
    const f = p.locator('[data-testid="wx-filter"]');
    await f.fill('London');
    assert(await p.$eval(london, (e) => e.offsetParent !== null), 'London not shown by the filter');
    assert(!(await isShown(p, '[data-testid="wx-more"]')), 'button shown for 1 match');
    await f.fill('美國');
    const [us, usAll] = await shownOf(p, LISTS[1].item);
    const usBtn = (await p.locator('[data-testid="wx-more"]').textContent()).trim();
    assert(usAll === 9 && us === PHONE_FIRST.wx && usBtn === '顯示全部（9）', `美國: ${us}/${usAll} shown, button "${usBtn}"`);
    await p.locator('[data-testid="wx-more"]').tap();
    const [usOpen] = await shownOf(p, LISTS[1].item);
    assert(usOpen === 9, `美國 expanded: ${usOpen}`);
    await p.locator('[data-testid="wx-more"]').tap();
    await f.fill('');
    await p.locator('[data-testid="wx-tab-europe"]').tap();
    const [eu, euAll] = await shownOf(p, LISTS[1].item);
    const euBtn = (await p.locator('[data-testid="wx-more"]').textContent()).trim();
    assert(euAll === 22 && eu === PHONE_FIRST.wx && euBtn === '顯示全部（22）', `歐洲、非洲: ${eu}/${euAll}, button "${euBtn}"`);

    // destinations: Japan is not among the first 8 (sorted by warning level); name filter, preset and sort
    const jp = '#dest-table tbody tr[data-iso="JP"]';
    assert(!(await p.$eval(jp, (e) => e.offsetParent !== null)), 'Japan row shown before filtering');
    await p.locator('#f-text').fill('日本');
    assert(await p.$eval(jp, (e) => e.offsetParent !== null), 'Japan row not shown by the name filter');
    assert(!(await isShown(p, '[data-testid="t-more"]')), 'button shown for a single destination');
    await p.locator('#f-text').fill('');
    await p.locator('[data-testid="preset-attention"]').tap();
    const [att, attAll] = await shownOf(p, LISTS[2].item);
    const attBtn = (await p.locator('[data-testid="t-more"]').textContent()).trim();
    assert(attAll > PHONE_FIRST.t && attAll < 248 && att === PHONE_FIRST.t && attBtn === `顯示全部（${attAll}）`, `需特別注意: ${att}/${attAll}, button "${attBtn}"`);
    await p.locator('[data-testid="preset-attention"]').tap();
    await p.locator('#dest-table th[data-key="name"] button').tap();
    const first = await p.$$eval('#dest-table tbody tr:not([hidden])', (els) => els.slice(0, 9).map((e) => e.offsetParent !== null).join());
    assert(first === 'true,true,true,true,true,true,true,true,false', `after sorting by name the first rows are ${first}`);

    // clinics: the last clinic in the list is hidden; filtering by its city makes it shown or one tap away
    const last = await p.$$eval('[data-testid="cl-card"]', (els) => {
      const e = els[els.length - 1];
      return { id: e.dataset.id, shown: e.offsetParent !== null };
    });
    assert(!last.shown, 'last clinic shown before filtering');
    const city = await p.evaluate(async (id) => {
      const d = await (await fetch('data/travelmed.json')).json();
      return d.clinics.find((c) => String(c.id) === id).city;
    }, last.id);
    await p.selectOption('[data-testid="cl-city"]', city);
    const [cl, clAll] = await shownOf(p, LISTS[0].item);
    const sel = `[data-testid="cl-card"][data-id="${last.id}"]`;
    assert(cl === Math.min(clAll, PHONE_FIRST.cl), `${city}: ${cl}/${clAll} shown`);
    assert(await isShown(p, '[data-testid="cl-more"]') === (clAll > PHONE_FIRST.cl), `${city}: button with ${clAll} clinics`);
    if (!(await p.$eval(sel, (e) => e.offsetParent !== null))) await p.locator('[data-testid="cl-more"]').tap();
    assert(await p.$eval(sel, (e) => e.offsetParent !== null), 'filtered clinic not reachable');
    await ctx.close();
    return `London 1, 美國 ${us}/${usAll}, 歐洲 ${eu}/${euAll}, 需特別注意 ${att}/${attAll}, ${city} ${cl}/${clAll}`;
  });

  await check('phone 390: section chips stay in one row at the top while scrolling; a chip jump shows the heading and marks the chip', async () => {
    const out = [];
    for (const lang of ['zh', 'en']) {
      const { ctx, p } = await openPhone(context, `?lang=${lang}#JP`);
      await p.evaluate(() => window.scrollTo(0, 3000));
      await p.waitForTimeout(300);
      const bar = await p.evaluate(() => {
        const nav = document.querySelector('[data-testid="jump"]');
        const r = nav.getBoundingClientRect();
        const cs = getComputedStyle(nav);
        const tops = [...nav.querySelectorAll('a')].map((a) => Math.round(a.getBoundingClientRect().top));
        const mid = document.elementFromPoint(20, r.top + r.height / 2);
        return {
          top: Math.round(r.top), bottom: Math.round(r.bottom), rows: new Set(tops).size, scrolls: nav.scrollWidth > nav.clientWidth,
          bg: cs.backgroundColor, onTop: !!mid && nav.contains(mid), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
          clipped: [...nav.querySelectorAll('a')].filter((a) => a.scrollWidth > a.clientWidth + 1 || a.getBoundingClientRect().height > 48).length,
        };
      });
      assert(bar.top >= 0 && bar.top <= 1 && bar.bottom <= 64, `${lang}: chip row at ${bar.top}–${bar.bottom}px after scrolling`);
      assert(bar.rows === 1 && bar.scrolls && !bar.clipped, `${lang}: ${bar.rows} row(s), scrolls ${bar.scrolls}, ${bar.clipped} clipped chip(s)`);
      assert(/^rgb\(/.test(bar.bg) && bar.onTop, `${lang}: chip row background ${bar.bg}, on top ${bar.onTop}`);
      assert(bar.sw <= bar.cw, `${lang}: page overflows (${bar.sw} > ${bar.cw})`);
      for (const [id, h2] of [['changes', 'chg-h'], ['clinics', 'cl-h'], ['all', 'all-h'], ['weather', 'wx-h']]) {
        await p.locator(`[data-testid="jump"] a[href="#${id}"]`).tap();
        await p.waitForFunction((href) => document.querySelector('[data-testid="jump"] a[aria-current]')?.getAttribute('href') === href, `#${id}`, { timeout: 4000 });
        const j = await p.evaluate(([hid]) => {
          const h = document.getElementById(hid).getBoundingClientRect();
          const nav = document.querySelector('[data-testid="jump"]');
          const n = nav.getBoundingClientRect();
          const cur = nav.querySelector('a[aria-current]').getBoundingClientRect();
          const hit = document.elementFromPoint(h.left + 10, h.top + h.height / 2);
          return {
            top: Math.round(h.top), bar: Math.round(n.bottom), navTop: Math.round(n.top), hit: !!hit && !!hit.closest(`#${hid}`),
            current: nav.querySelectorAll('a[aria-current]').length, chipIn: cur.left >= n.left - 1 && cur.right <= n.right + 1,
          };
        }, [h2]);
        assert(j.navTop <= 1 && j.top >= j.bar && j.top < 260 && j.hit, `${lang} #${id}: heading at ${j.top}px, chip row ends at ${j.bar}px, hit ${j.hit}`);
        assert(j.current === 1 && j.chipIn, `${lang} #${id}: ${j.current} current chip(s), inside the row ${j.chipIn}`);
      }
      // the card has no chip: nothing is marked while it is being read; opening it lands below the chip row
      await p.evaluate(() => { location.hash = '#KH'; });
      await p.waitForFunction(() => document.querySelector('#card')?.dataset.iso === 'KH', null, { timeout: 4000 });
      await p.waitForFunction(() => {
        const t = document.querySelector('#card-title').getBoundingClientRect().top;
        return t > 40 && t < 200 && !document.querySelector('[data-testid="jump"] a[aria-current]');
      }, null, { timeout: 6000 });
      await ctx.close();
      out.push(`${lang}: row ${bar.top}–${bar.bottom}px`);
    }
    return out.join(', ');
  });

  await check('phone 390: back-to-top appears after 1.5 screens, stays clear of the kiosk reset button and the footer, and returns to the top', async () => {
    const { ctx, p } = await openPhone(context, '?osk=1&lang=en#JP');
    await p.waitForSelector('[data-testid="kiosk-reset"]', { timeout: 10000 });
    const btn = '[data-testid="to-top"]';
    assert(!(await isShown(p, btn)), 'shown at the top of the page');
    await p.evaluate(() => window.scrollTo(0, 900));
    await p.waitForTimeout(250);
    assert(!(await isShown(p, btn)), 'shown after about one screen');
    await p.evaluate(() => window.scrollTo(0, 2600));
    await p.waitForFunction((s) => !document.querySelector(s).hidden, btn, { timeout: 4000 });
    const m = await p.evaluate((s) => {
      const b = document.querySelector(s);
      const r = b.getBoundingClientRect();
      const k = document.querySelector('[data-testid="kiosk-reset"]').getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        w: r.width, h: r.height, right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.bottom),
        label: b.getAttribute('aria-label'), title: b.title, hit: hit === b || b.contains(hit),
        apart: r.left >= k.right || r.top >= k.bottom || r.bottom <= k.top,
      };
    }, btn);
    assert(m.w >= 44 && m.h >= 44, `button is ${m.w}×${m.h}px`);
    assert(m.label === 'Back to top' && m.title === 'Back to top', `label "${m.label}", title "${m.title}"`);
    assert(m.right >= 8 && m.right <= 24 && m.bottom >= 8 && m.bottom <= 24 && m.hit, `at right ${m.right}px / bottom ${m.bottom}px, on top ${m.hit}`);
    assert(m.apart, 'overlaps the kiosk reset button');
    await p.locator('[data-testid="lang-toggle"]').evaluate((b) => b.click());
    const zh = await p.$eval(btn, (b) => `${b.getAttribute('aria-label')}|${b.title}`);
    assert(zh === '回到頁面頂端|回到頁面頂端', `Chinese label "${zh}"`);
    // at the end of the page the button rides above the footer
    await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await p.waitForFunction((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      const f = document.querySelector('.foot').getBoundingClientRect();
      const more = document.querySelector('[data-testid="t-more"]').getBoundingClientRect();
      return f.top < window.innerHeight && r.bottom <= f.top && r.top >= more.bottom && r.top > 70;
    }, btn, { timeout: 4000 });
    await p.locator(btn).tap();
    await p.waitForFunction(() => window.scrollY === 0, null, { timeout: 8000 });
    await p.waitForFunction((s) => document.querySelector(s).hidden, btn, { timeout: 4000 });
    await ctx.close();
    // prefers-reduced-motion: no animated scroll
    const r = await openPhone(context, '#JP', { reducedMotion: 'reduce' });
    await r.p.evaluate(() => window.scrollTo(0, 6000));
    await r.p.waitForFunction((s) => !document.querySelector(s).hidden, btn, { timeout: 4000 });
    await r.p.locator(btn).tap();
    const y = await r.p.evaluate(() => new Promise((res) => requestAnimationFrame(() => res(window.scrollY))));
    await r.ctx.close();
    assert(y === 0, `reduced motion: at ${y}px one frame after the tap`);
    return `${m.w}×${m.h}px, ${m.right}px from the right, ${m.bottom}px from the bottom`;
  });

  await check('Back closes the destination card and stays on trip.html (search, table row, after a chip jump); switching destinations adds no entry', async () => {
    const { ctx, p } = await openPhone(context, '?lang=zh');
    const here = () => p.evaluate(() => `${location.pathname.split('/').pop()}${location.hash}`);
    await p.evaluate(() => { window.__same = 1; });
    const len0 = await p.evaluate(() => history.length);
    // search → card → Back
    await p.locator('[data-testid="search"]').fill('日本');
    await p.locator('#q-list [role="option"]').first().waitFor({ timeout: 4000 });
    await p.locator('#q-list [role="option"]').first().tap();
    await p.locator(CARD).waitFor({ state: 'visible', timeout: 4000 });
    assert(await here() === 'trip.html#JP', `after choosing: ${await here()}`);
    assert(await p.evaluate(() => history.length) === len0 + 1, 'choosing a destination added no history entry');
    await p.goBack();
    await p.waitForFunction(() => document.querySelector('#card').hidden, null, { timeout: 4000 });
    assert(await here() === 'trip.html' && await p.evaluate(() => window.__same === 1), `after Back: ${await here()}`);
    // Forward opens it again; another destination replaces the entry; one Back closes
    await p.goForward();
    await p.locator(CARD).waitFor({ state: 'visible', timeout: 4000 });
    await p.locator(`${WX} .wx-city[data-iso="KR"] .wx-open`).first().evaluate((b) => b.click());
    await p.waitForFunction(() => location.hash === '#KR' && document.querySelector('#card').dataset.iso === 'KR', null, { timeout: 4000 });
    assert(await p.evaluate(() => history.length) === len0 + 1, 'switching destinations added a history entry');
    await p.goBack();
    await p.waitForFunction(() => document.querySelector('#card').hidden, null, { timeout: 4000 });
    assert(await here() === 'trip.html', `after Back from the second destination: ${await here()}`);
    // chip jump, scroll on, tap a row, Back: card closed, same place in the list, still on trip.html#all
    await p.locator('[data-testid="jump"] a[href="#all"]').tap();
    const row = p.locator('#dest-table tbody tr:not([hidden]) .rowbtn').nth(3);
    const iso = await row.evaluate((b) => b.closest('tr').dataset.iso);
    await row.evaluate((b) => b.scrollIntoView({ block: 'center' }));
    await p.waitForTimeout(400);
    const y0 = await scrollY(p);
    await row.tap();
    await p.waitForFunction((want) => location.hash === `#${want}` && !document.querySelector('#card').hidden, iso, { timeout: 4000 });
    await p.goBack();
    await p.waitForFunction(() => document.querySelector('#card').hidden, null, { timeout: 4000 });
    await p.waitForFunction((y) => Math.abs(window.scrollY - y) <= 2, y0, { timeout: 4000 });
    assert(await here() === 'trip.html#all' && await p.evaluate(() => window.__same === 1), `after Back to the list: ${await here()}`);
    // the card's own close button goes back the same way (no entries pile up), and Escape too
    await row.tap();
    await p.locator(CARD).waitFor({ state: 'visible', timeout: 4000 });
    const len1 = await p.evaluate(() => history.length);
    await p.locator(`${CARD} .card-actions button`).last().tap();
    await p.waitForFunction(() => document.querySelector('#card').hidden && location.hash === '#all', null, { timeout: 4000 });
    await row.tap();
    await p.locator(CARD).waitFor({ state: 'visible', timeout: 4000 });
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => document.querySelector('#card').hidden && location.hash === '#all', null, { timeout: 4000 });
    assert(await p.evaluate(() => history.length) === len1, `history grew from ${len1} to ${await p.evaluate(() => history.length)} entries`);
    await ctx.close();
    return `search, Forward, switch, row ${iso}: Back closes the card; scroll position kept (${y0}px)`;
  });

  await check('a direct #JP load opens Japan without an extra history entry; closing clears the hash; a reload keeps the card', async () => {
    const { ctx, p } = await openPhone(context, '?lang=zh#JP');
    const s = await p.evaluate(() => ({ open: !document.querySelector('#card').hidden, title: document.querySelector('#card-title')?.textContent || '', len: history.length, state: history.state }));
    assert(s.open && s.title.includes('日本'), `card "${s.title}"`);
    assert(s.state === null, `history state ${JSON.stringify(s.state)} on a direct load`);
    await p.locator(`${CARD} .card-actions button`).last().tap();
    await p.waitForFunction(() => document.querySelector('#card').hidden, null, { timeout: 4000 });
    const closed = await p.evaluate(() => `${location.pathname.split('/').pop()}${location.search}${location.hash}|${history.length}`);
    assert(closed === `trip.html?lang=zh|${s.len}`, `after closing: ${closed} (${s.len} entries before)`);
    // chosen in the page, then reloaded (kiosk self-reload): the card comes back, and Back still closes it
    await p.locator('#dest-table tbody tr:not([hidden]) .rowbtn').first().evaluate((b) => b.click());
    await p.locator(CARD).waitFor({ state: 'visible', timeout: 4000 });
    const hash = await p.evaluate(() => location.hash);
    await p.reload({ waitUntil: 'load' });
    await p.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
    assert(await cardOpen(p) && await p.evaluate(() => location.hash) === hash, `after reload: card ${await cardOpen(p)}, ${await p.evaluate(() => location.hash)}`);
    await p.goBack();
    await p.waitForFunction(() => document.body.dataset.ready === '1' && document.querySelector('#card').hidden && !location.hash, null, { timeout: 15000 });
    const end = await p.evaluate(() => location.pathname.split('/').pop());
    await ctx.close();
    assert(end === 'trip.html', `Back after the reload left the page (${end})`);
    return `${s.title}; reload kept ${hash}`;
  });

  await check('phone 390: the new controls are legible in both themes (contrast ≥ 4.5) and at the largest text size', async () => {
    const out = [];
    for (const theme of ['light', 'dark']) {
      const ctx = await context.browser().newContext(PHONE);
      await ctx.addInitScript((th) => { try { localStorage.setItem('safetravel.trip.theme', th); } catch {} }, theme);
      const p = await ctx.newPage();
      p.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
      await p.goto(`${PAGE_URL.split('#')[0].split('?')[0]}?lang=en&text=xl#JP`, { waitUntil: 'load' });
      await p.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
      await p.waitForSelector('[data-testid="cl-card"]', { state: 'attached', timeout: 15000 });
      await p.locator('[data-testid="jump"] a[href="#weather"]').tap();
      await p.waitForFunction(() => document.querySelector('[data-testid="jump"] a[aria-current]') && !document.querySelector('[data-testid="to-top"]').hidden, null, { timeout: 4000 });
      const r = await p.evaluate(() => {
        const lum = (c) => {
          const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (el) => {
          const cs = getComputedStyle(el);
          const [a, b] = [lum(cs.color), lum(cs.backgroundColor)].sort((x, y) => y - x);
          const alpha = cs.backgroundColor.match(/[\d.]+/g)[3];
          return { ratio: Math.round(((a + 0.05) / (b + 0.05)) * 10) / 10, solid: alpha === undefined || Number(alpha) === 1 };
        };
        const q = (s) => document.querySelector(s);
        const more = q('[data-testid="wx-more"]');
        const nav = q('[data-testid="jump"]');
        return {
          theme: document.documentElement.dataset.theme, ts: document.documentElement.dataset.ts,
          more: ratio(more), top: ratio(q('[data-testid="to-top"]')), cur: ratio(nav.querySelector('a[aria-current]')), chip: ratio(nav.querySelector('a:not([aria-current])')),
          moreFits: more.scrollWidth <= more.clientWidth && more.getBoundingClientRect().height < 80,
          navTop: Math.round(nav.getBoundingClientRect().top), rows: new Set([...nav.querySelectorAll('a')].map((a) => Math.round(a.getBoundingClientRect().top))).size,
          headTop: Math.round(q('#wx-h').getBoundingClientRect().top), barBottom: Math.round(nav.getBoundingClientRect().bottom),
        };
      });
      await ctx.close();
      assert(r.theme === theme && r.ts === 'xl', `theme ${r.theme}, text size ${r.ts}`);
      for (const k of ['more', 'top', 'cur', 'chip']) assert(r[k].ratio >= 4.5 && r[k].solid, `${theme}: ${k} contrast ${r[k].ratio}, solid ${r[k].solid}`);
      assert(r.moreFits && r.rows === 1 && r.navTop <= 1, `${theme}: button fits ${r.moreFits}, ${r.rows} chip row(s) at ${r.navTop}px`);
      assert(r.headTop >= r.barBottom, `${theme}: heading at ${r.headTop}px under a chip row ending at ${r.barBottom}px`);
      out.push(`${theme}: ${r.more.ratio} / ${r.top.ratio} / ${r.cur.ratio}`);
    }
    return out.join('; ');
  });

  await check('desktop 1440×900 is unchanged: every item rendered, no “show all”, no sticky chip row, no back-to-top', async () => {
    const p = await context.newPage();
    p.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    await p.goto(`${PAGE_URL.split('#')[0]}#JP`, { waitUntil: 'load' });
    await p.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
    await p.waitForSelector('[data-testid="cl-card"]', { timeout: 15000 });
    const counts = {};
    for (const L of LISTS) counts[L.key] = await shownOf(p, L.item);
    const top = await p.evaluate(() => ({
      more: [...document.querySelectorAll('.more-btn')].filter((b) => getComputedStyle(b).display !== 'none').length,
      toTop: getComputedStyle(document.querySelector('[data-testid="to-top"]')).display,
    }));
    await p.evaluate(() => window.scrollTo(0, 4000));
    await p.waitForTimeout(400);
    const m = await p.evaluate(() => {
      const nav = document.querySelector('[data-testid="jump"]');
      return {
        more: [...document.querySelectorAll('.more-btn')].filter((b) => getComputedStyle(b).display !== 'none').length,
        toTop: getComputedStyle(document.querySelector('[data-testid="to-top"]')).display, toTopHidden: document.querySelector('[data-testid="to-top"]').hidden,
        header: getComputedStyle(document.querySelector('.top')).position, navBottom: Math.round(nav.getBoundingClientRect().bottom),
        wrap: getComputedStyle(nav).flexWrap, current: nav.querySelectorAll('[aria-current]').length,
        pad: getComputedStyle(document.documentElement).scrollPaddingTop, vars: document.documentElement.getAttribute('style') || '',
        y: Math.round(window.scrollY),
      };
    });
    await p.close();
    for (const [k, [shown, total]] of Object.entries(counts)) assert(shown === total && total > PHONE_FIRST[k], `${k}: ${shown} of ${total} rendered`);
    assert(counts.wx[1] === 80 && counts.t[1] > 150 && counts.cl[1] >= 30, `counts ${JSON.stringify(counts)}`);
    assert(top.more === 0 && top.toTop === 'none', `at the top: ${top.more} “show all” button(s), back-to-top display ${top.toTop}`);
    assert(m.y > 3000 && m.more === 0 && m.toTop === 'none' && m.toTopHidden, `after scrolling to ${m.y}px: ${m.more} button(s), back-to-top ${m.toTop}`);
    assert(m.header === 'static' && m.navBottom < 0 && m.wrap === 'wrap', `header ${m.header}, chip row bottom at ${m.navBottom}px, flex-wrap ${m.wrap}`);
    assert(m.current === 0 && m.pad === '12px' && !m.vars.includes('--jump'), `aria-current ${m.current}, scroll-padding ${m.pad}, style "${m.vars}"`);
    return `clinics ${counts.cl[1]}, cities ${counts.wx[1]}, destinations ${counts.t[1]}`;
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
