// SafeTravel TW — malaria.html (瘧疾預防用藥試算, draft) smoke test (Playwright + Chromium).
//
// Usage:   node tests/malaria-smoke.mjs [pageURL]      (default http://localhost:8080/malaria.html)
// Env:     CHROMIUM_PATH  optional chromium binary; HEADED=1 visible browser
// Serve the site first: python -m http.server -d web 8080. Exit code 0 when every check passes.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const PAGE_URL = new URL(process.argv[2] || 'http://localhost:8080/malaria.html').href;
const results = [];
const consoleErrors = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: String(err?.message || err).split('\n')[0] });
    console.log(`[FAIL] ${name} — ${String(err?.message || err).split('\n')[0]}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function open(context, { lang } = {}) {
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  if (lang) await page.addInitScript((l) => { try { localStorage.setItem('safetravel.lang', l); } catch {} }, lang);
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
  return page;
}

async function trip(page, iso, arrive, depart, visit) {
  await page.selectOption('[data-testid="leg-country"] >> nth=-1', iso);
  await page.fill('[data-testid="leg-arrive"] >> nth=-1', arrive);
  await page.fill('[data-testid="leg-depart"] >> nth=-1', depart);
  if (visit) await page.locator('[data-testid="leg"]').last().locator(`[data-testid="visit-${visit}"]`).check();
}
async function person(page, age, weight) {
  await page.fill('[data-testid="age"]', String(age));
  await page.fill('[data-testid="weight"]', String(weight));
}
const text = (page, id) => page.locator(`[data-testid="${id}"]`).first().textContent();
const status = (page, id) => page.getAttribute(`[data-testid="drug-${id}"]`, 'data-status');
const verdict = (page) => page.getAttribute('[data-testid="verdict"]', 'data-verdict');

async function main() {
  const browser = await chromium.launch({ headless: !process.env.HEADED, executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });

  await check('page loads with the draft banner and an empty itinerary', async () => {
    const page = await open(context);
    assert(await page.isVisible('[data-testid="draft-banner"]'), 'no draft banner');
    assert(await verdict(page) === 'incomplete', 'verdict should wait for the itinerary');
    const robots = await page.getAttribute('meta[name="robots"]', 'content');
    assert(robots === 'noindex', 'draft page should be noindex');
    await page.close();
  });

  await check('Kenya 10–20 Dec, adult 70 kg: three drugs, doses and tablets per CDC regimens, cost', async () => {
    const page = await open(context);
    await trip(page, 'KE', '2026-12-10', '2026-12-20', 'yes');
    await person(page, 35, 70);
    assert(await verdict(page) === 'need', `verdict ${await verdict(page)}`);
    for (const d of ['atq', 'dox', 'mef']) assert(await status(page, d) === 'ok', `${d} ${await status(page, d)}`);
    // Malarone: 2 days before + 11 days + 7 after = 20; doxycycline 2 + 11 + 28 = 41; mefloquine weekly from 2 weeks before, 4 after = 8
    const n = { atq: await text(page, 'doses-atq'), dox: await text(page, 'doses-dox'), mef: await text(page, 'doses-mef') };
    assert(n.atq.startsWith('20') && n.dox.startsWith('41') && n.mef.startsWith('8'), JSON.stringify(n));
    assert((await text(page, 'first-mef')).startsWith('2026-11-26'), `mef first ${await text(page, 'first-mef')}`);
    assert((await text(page, 'last-dox')).startsWith('2027-01-17'), `dox last ${await text(page, 'last-dox')}`);
    await page.selectOption('[data-testid="lead-atq"]', '1');
    assert((await text(page, 'doses-atq')).startsWith('19'), 'lead 1 day → 19 doses');
    await page.fill('[data-testid="price-dox"]', '12');
    const cost = await text(page, 'cost-dox');
    assert(cost.includes('492'), `cost ${cost}`);
    assert(await page.inputValue('[data-testid="weight"]') === '70', 'weight changed while typing a price');
    await page.close();
    return `${n.atq} / ${n.dox} / ${n.mef}; ${cost}`;
  });

  await check('Thailand: mefloquine ruled out (resistance); "not going to risk areas" → no medicine', async () => {
    const page = await open(context);
    await trip(page, 'TH', '2026-12-10', '2026-12-17', 'yes');
    await person(page, 40, 60);
    assert(await status(page, 'mef') === 'no', `mef ${await status(page, 'mef')}`);
    await page.locator('[data-testid="visit-no"]').check();
    assert(await verdict(page) === 'avoid-areas', `verdict ${await verdict(page)}`);
    await page.close();
  });

  await check('Japan → no risk; South Korea → mosquito protection only', async () => {
    const page = await open(context);
    await trip(page, 'JP', '2026-12-10', '2026-12-17');
    const jp = await verdict(page);
    await trip(page, 'KR', '2026-12-10', '2026-12-17');
    const kr = await verdict(page);
    await page.close();
    assert(jp === 'none' && kr === 'bites', `JP ${jp}, KR ${kr}`);
  });

  await check('Timor-Leste: CDC malaria-page note (certified malaria-free 2025) shown beside the prescription', async () => {
    const page = await open(context);
    await trip(page, 'TL', '2026-12-10', '2026-12-17');
    const note = await page.textContent('[data-testid="who-note"]');
    await page.close();
    assert(note.includes('2025'), note);
  });

  await check('pregnancy: Malarone and doxycycline not suitable, mefloquine can be considered', async () => {
    const page = await open(context);
    await trip(page, 'KE', '2026-12-10', '2026-12-20', 'yes');
    await person(page, 30, 60);
    await page.selectOption('[data-testid="pregnant"]', 'yes');
    const s = [await status(page, 'atq'), await status(page, 'dox'), await status(page, 'mef')];
    await page.close();
    assert(s.join() === 'no,no,ok', s.join());
  });

  await check('child 10 y / 25 kg: mefloquine ½ tablet weekly, doxycycline 55 mg (no count), Malarone by the doctor', async () => {
    const page = await open(context);
    await trip(page, 'KE', '2026-12-10', '2026-12-20', 'yes');
    await person(page, 10, 25);
    const mef = await text(page, 'dose-mef');
    const buy = await text(page, 'buy-mef');
    const dox = await text(page, 'dose-dox');
    const atq = await text(page, 'buy-atq');
    await page.close();
    assert(mef.startsWith('½') && buy.startsWith('4'), `mef ${mef} buy ${buy}`);
    assert(dox.includes('55'), `dox ${dox}`);
    assert(!/\d/.test(atq), `atq buy ${atq}`);
    return `mef ${mef}, buy ${buy}; dox ${dox}`;
  });

  await check('calendar: .ics has the repeat rule and an alarm; Google link carries the RRULE', async () => {
    const page = await open(context);
    await trip(page, 'KE', '2026-12-10', '2026-12-20', 'yes');
    await person(page, 35, 70);
    await page.fill('[data-testid="time-dox"]', '21:30');
    const href = await page.getAttribute('[data-testid="gcal-dox"]', 'href');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="ics-dox"]')]);
    const ics = readFileSync(await dl.path(), 'utf8');
    await page.close();
    assert(href.startsWith('https://calendar.google.com/calendar/render?') && decodeURIComponent(href).includes('RRULE:FREQ=DAILY;COUNT=41'), href);
    assert(decodeURIComponent(href).includes('20261208T213000'), 'reminder time not applied');
    assert(/RRULE:FREQ=DAILY;COUNT=41/.test(ics) && /BEGIN:VALARM/.test(ics) && /DTSTART:20261208T213000/.test(ics), ics.slice(0, 300));
    assert(/DTSTART;VALUE=DATE:20261221/.test(ics), 'malaria watch event missing');
    return dl.suggestedFilename();
  });

  await check('two stops: risk window spans both; English UI', async () => {
    const page = await open(context, { lang: 'en' });
    await trip(page, 'KE', '2026-12-10', '2026-12-15', 'yes');
    await page.click('[data-testid="add-leg"]');
    await trip(page, 'TZ', '2026-12-15', '2026-12-24', 'unsure');
    await person(page, 35, 70);
    const win = await text(page, 'window');
    const title = await page.textContent('h1');
    await page.close();
    assert(/2026-12-10.*2026-12-24.*15 days/.test(win), win);
    assert(title.includes('Malaria'), title);
    return win;
  });

  await check('phone width 390: no horizontal overflow', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    await trip(page, 'KE', '2026-12-10', '2026-12-20', 'yes');
    await person(page, 35, 70);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await ctx.close();
    assert(over <= 0, `overflow ${over}px`);
  });

  await check('risk map: CDC and WHO layers, legend counts, source credit, click adds the country to the itinerary', async () => {
    const page = await open(context);
    await page.waitForSelector('.mm-cts path[data-iso="KE"]', { timeout: 15000 });
    const n = await page.locator('.mm-cts path').count();
    assert(n > 150, `${n} paths`);
    const fill = () => page.$eval('.mm-cts path[data-iso="KE"]', (el) => getComputedStyle(el).fill);
    const cdc = await fill();
    await page.click('[data-testid="layer-who"]');
    await page.waitForTimeout(400); // fill transition
    const who = await fill();
    assert(cdc !== who, `KE fill unchanged (${cdc})`);
    const legend = await page.textContent('[data-testid="map-legend"]');
    assert(/有本土病例|indigenous/.test(legend) && /\d/.test(legend), legend);
    const src = await page.textContent('[data-testid="map-source"]');
    const imgHref = await page.getAttribute('[data-testid="map-source"] a', 'href');
    assert(/World Malaria Report 2025/.test(src) && imgHref.includes('cdc.gov.tw/File/Get/'), src);
    await page.$eval('.mm-cts path[data-iso="KE"]', (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.$eval('.mm-cts path[data-iso="TZ"]', (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const picked = await page.$$eval('[data-testid="leg-country"]', (s) => s.map((x) => x.value));
    const status = await page.textContent('[data-testid="map-status"]');
    const marked = await page.$$eval('.mm-cts path.is-trip', (ps) => ps.map((p) => p.dataset.iso).sort());
    await page.close();
    assert(picked.join() === 'KE,TZ', `legs ${picked}`);
    assert(marked.join() === 'KE,TZ', `marked ${marked}`);
    return `${n} countries; ${status.trim()}`;
  });

  await check('no console errors', async () => {
    assert(!consoleErrors.length, consoleErrors[0]);
  });

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nchecks: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
