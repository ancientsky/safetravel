// m.html — 旅遊疫情快查: the personal / phone version. Search first, one country card at a time, no map.
// Two roles (localStorage 'safetravel.role', ?role=officer|public):
//   officer  airport quarantine staff: inbound flights tab, flights from the country on its card, flight-number search
//   public   travellers: popular destinations, MOFA / MAC travel warning summary, link to the full trip check
// Data: alerts.json + countries.json at start; warnings.json, epidemics-recent.json, arrivals.json and the place
// index (places.js) only when a view needs them. Every data string is escaped (esc) before it reaches innerHTML.
import { state, levelOf, groupAlerts, warnLevel, warningOf } from './state.js';
import {
  setLang, getLang, isEn, t, applyStatic, bindData, countryName, countryAltName, diseaseName, levelShort, levelFull,
  levelInstruction, badge, wbadge, wLevelFull, fmtDay, pick,
} from './i18n.js';
import { $, esc, storageGet, storageSet, safeUrl, levelNum, truncate, urlLang, syncUrlLang } from './util.js';
import { loadPlaces, findPlaces, placeName } from './places.js';
import { bindTextSize } from './textsize.js';
import { bestTime, flightKey } from './arrivals.js';
import { autoReload } from './autoreload.js';

// js/boot-guard.js: this module and all its imports loaded and linked (no half-updated cache)
document.documentElement.dataset.booted = '1';

const ROLE_KEY = 'safetravel.role';
const THEME_KEY = 'safetravel.m.theme';
const LANG_KEY = 'safetravel.lang';
const FCFG_KEY = 'safetravel.m.flights';
const POPULAR = ['JP', 'KR', 'TH', 'VN', 'CN', 'HK', 'MO', 'PH', 'ID', 'MY', 'SG', 'KH', 'US', 'AU', 'GB'];
const WINDOWS = [30, 60, 120, 0];
const MOFA_HOSTS = ['www.boca.gov.tw', 'boca.gov.tw', 'www.mac.gov.tw', 'mac.gov.tw'];
const STATUSES = new Set(['arrived', 'on_time', 'early', 'delayed', 'changed', 'cancelled', 'other']);
const HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hm = (ms) => (Number.isFinite(ms) ? HM.format(ms) : '—');
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\-‐-―_.,'’()（）・·]+/g, '');
const CJK = /[㐀-鿿]/;
const ISO2 = /^[A-Z]{2}$/;

const app = {
  role: null, view: 'home', iso: '', hotFlight: '', results: [], active: -1,
  fcfg: { airport: 'TPE', win: 60, risk: false },
};

// ---------------------------------------------------------------- data (each file fetched at most once)
const cache = new Map();
function getJSON(file, { fresh = false } = {}) {
  if (fresh || !cache.has(file)) {
    cache.set(file, fetch(`data/${file}${fresh ? `?t=${Math.floor(Date.now() / 30000)}` : ''}`, { cache: fresh ? 'no-store' : 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`); return r.json(); })
      .catch((e) => { cache.delete(file); throw e; }));
  }
  return cache.get(file);
}
let arrivals = null; // data/arrivals.json
let recent = null; // data/epidemics-recent.json
function needWarnings() {
  if (state.data.warnings || cache.has('warnings.json')) return;
  getJSON('warnings.json').then((w) => { state.data.warnings = w; rerender(); }, () => {});
}
function needRecent() {
  if (recent || cache.has('epidemics-recent.json')) return;
  getJSON('epidemics-recent.json').then((d) => { recent = d; rerender(); }, () => { recent = { items: [], failed: true }; rerender(); });
}
function needArrivals(force = false) {
  if (app.role !== 'officer') return;
  if (!force && (arrivals || cache.has('arrivals.json'))) return;
  getJSON('arrivals.json', { fresh: true }).then((d) => {
    if (d && Array.isArray(d.flights)) { arrivals = d; rerender(); }
  }, () => { if (!arrivals) { arrivals = { flights: [], airports: {}, failed: true }; rerender(); } });
}

// ---------------------------------------------------------------- small renderers
const lvlBadge = (iso, cls = '') => {
  const l = levelOf(iso);
  return l ? badge(l, levelShort(l), cls) : `<span class="badge ${esc(cls)}">${esc(t('m_no_level'))}</span>`;
};
const chip = (iso, extra = '') => `<button type="button" class="m-chip" data-iso="${esc(iso)}"><i class="dot lvl-${levelOf(iso)}" aria-hidden="true"></i>${
  esc(countryName(iso))}${extra}</button>`;
const sec = (title, body, { sub = '', more = '' } = {}) => `<section class="m-sec"><h2>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}${more}</h2>${body}</section>`;
const statusText = (f) => {
  const st = STATUSES.has(f.status) ? f.status : 'other';
  return st === 'other' ? ((isEn() ? f.status_en : f.status_zh) || t('arr_status_other')) : t(`arr_status_${st}`);
};

function flightRow(f, now) {
  const iso = ISO2.test(f.country || '') ? f.country : '';
  const tm = bestTime(f);
  const st = STATUSES.has(f.status) ? f.status : 'other';
  const mins = Math.round((tm - now) / 60000);
  const rel = mins >= 0 && st !== 'arrived' ? t('arr_in', { n: mins }) : t('arr_ago', { n: -mins });
  const city = (isEn() ? f.from_en : f.from_zh) || f.from_en || f.from || '';
  const gate = String(f.gate || '').trim();
  const belt = st !== 'cancelled' && typeof f.carousel === 'string' && /^[0-9A-Z-]{1,4}$/.test(f.carousel) ? f.carousel : '';
  return `<li class="f-row lvl-${iso ? levelOf(iso) : 0} st-${st}${f.id === app.hotFlight ? ' is-hit' : ''}"${iso ? ` data-iso="${esc(iso)}"` : ''} data-fid="${esc(f.id)}" tabindex="0" role="button">
      <span class="f-time"><b class="mono">${esc(hm(tm))}</b><small>${esc(rel)}</small></span>
      <span class="f-main">
        <span class="f-city">${esc(city)}<span class="mono">${esc(f.from || '')}</span></span>
        <span class="f-sub"><span>${esc(iso ? countryName(iso) : '')}</span><span class="mono">${esc(f.flight || '')}</span>${iso && levelOf(iso) ? lvlBadge(iso, 'badge-sm') : ''}</span>
      </span>
      <span class="f-gate"><b class="mono">${esc(gate || t('arr_gate_tbd'))}</b>${f.terminal ? esc(t('arr_terminal', { term: f.terminal })) : ''}${f.checkpoint ? ` · ${esc(f.checkpoint)}` : ''}${
        belt ? `<br>${esc(t('arr_carousel'))} ${esc(belt)}` : ''}<br><span class="f-st st-${st}">${esc(statusText(f))}</span></span>
    </li>`;
}

function newsItem(it) {
  const h = pick(it, 'headline');
  const s = pick(it, 'summary');
  const url = safeUrl(it.url);
  const isos = (Array.isArray(it.countries) ? it.countries : []).filter((c) => ISO2.test(c)).slice(0, 4);
  return `<li class="n-item">
      <div class="n-meta"><span class="mono">${esc(fmtDay(it.date))}</span>${it.ai ? `<span class="n-ai">${esc(t('m_ai'))}</span>` : ''}<span>${esc(pick(it, 'disease').text)}</span></div>
      <h3>${esc(h.text)}</h3>
      <p>${esc(truncate(s.text, 220))}</p>
      <div class="n-foot">${isos.map((c) => chip(c)).join('')}${url ? `<a class="m-chip" href="${esc(url)}" target="_blank" rel="noopener">${esc(t('m_source'))} ↗</a>` : ''}</div>
    </li>`;
}

// ---------------------------------------------------------------- flights helpers (officer)
function airportFlights(code = app.fcfg.airport) {
  return (arrivals?.flights || []).filter((f) => f.airport === code && Number.isFinite(bestTime(f)));
}
function windowed(list, now, win = app.fcfg.win, risk = app.fcfg.risk) {
  const rows = list.filter((f) => (!win || Math.abs(bestTime(f) - now) <= win * 60000) && (!risk || levelOf(f.country) >= 2));
  const up = rows.filter((f) => f.status !== 'arrived' && bestTime(f) >= now).sort((a, b) => bestTime(a) - bestTime(b));
  const past = rows.filter((f) => !(f.status !== 'arrived' && bestTime(f) >= now)).sort((a, b) => bestTime(b) - bestTime(a));
  return { up, past };
}

// ---------------------------------------------------------------- views
function renderHome() {
  const node = $('#view-home');
  const now = Date.now();
  const c = state.data.alerts?.countries || {};
  const byLevel = (l) => Object.keys(c).filter((iso) => ISO2.test(iso) && levelOf(iso) === l).sort((a, b) => countryName(a).localeCompare(countryName(b), getLang()));
  const l3 = byLevel(3);
  const l2 = byLevel(2);
  const parts = [];
  if (app.role === 'officer') {
    needArrivals();
    let body;
    if (!arrivals) body = `<p class="m-empty">${esc(t('arr_loading'))}</p>`;
    else {
      const { up } = windowed(airportFlights('TPE'), now, 60, true);
      body = up.length ? `<ol class="f-list">${up.slice(0, 6).map((f) => flightRow(f, now)).join('')}</ol>`
        : `<p class="m-empty">${esc(arrivals.failed ? t('arr_error') : t('m_no_risky'))}</p>`;
    }
    parts.push(sec(t('m_sec_risky'), body, { sub: t('m_sec_risky_sub'), more: `<button type="button" class="m-link-btn more" data-go="flights">${esc(t('m_all_flights'))} →</button>` }));
  } else {
    parts.push(sec(t('m_sec_popular'), `<div class="m-chips">${POPULAR.filter((iso) => c[iso] || state.data.countries?.[iso]).map((iso) => chip(iso)).join('')}</div>`));
  }
  parts.push(sec(t('m_sec_l3'), l3.length ? `<div class="m-chips">${l3.map((iso) => chip(iso)).join('')}</div>` : `<p class="m-empty">${esc(t('m_none'))}</p>`, { sub: t('m_count', { n: l3.length }) }));
  parts.push(sec(t('m_sec_l2'), l2.length ? `<div class="m-chips">${l2.map((iso) => chip(iso)).join('')}</div>` : `<p class="m-empty">${esc(t('m_none'))}</p>`, { sub: t('m_count', { n: l2.length }) }));
  needRecent();
  const items = (recent?.items || []).slice(0, 3);
  parts.push(sec(t('m_sec_news'), recent ? (items.length ? `<ul class="n-list">${items.map(newsItem).join('')}</ul>` : `<p class="m-empty">${esc(t('m_none'))}</p>`)
    : `<p class="m-empty">${esc(t('m_loading'))}</p>`, { more: `<button type="button" class="m-link-btn more" data-go="news">${esc(t('m_all_news'))} →</button>` }));
  node.innerHTML = parts.join('');
}

function renderCard() {
  const node = $('#view-card');
  const iso = app.iso;
  if (!ISO2.test(iso)) { node.innerHTML = ''; return; }
  needWarnings();
  needRecent();
  const now = Date.now();
  const lvl = levelOf(iso);
  const groups = groupAlerts(iso);
  const cdc = `<div class="c-block">
      <h3>${esc(t('m_cdc_title'))}</h3>
      <div class="c-level">${lvlBadge(iso)}${lvl ? `<span>${esc(levelFull(lvl))}</span>` : ''}</div>
      ${lvl ? `<p class="c-instr">${esc(levelInstruction(lvl))}</p>` : `<p class="c-text">${esc(t('m_no_advisory'))}</p>`}
      ${groups.length ? `<ul class="c-list">${groups.map((g) => `<li>${badge(g.level, `L${levelNum(g.level)}`, 'badge-sm')}<span class="d-name">${esc(diseaseName(g.disease))}</span>${
        g.effective ? `<span class="d-date">${esc(t('m_effective', { date: fmtDay(g.effective) }))}</span>` : ''}</li>`).join('')}</ul>` : ''}
    </div>`;
  let mofa;
  if (!state.data.warnings) mofa = `<p class="c-text">${esc(t('m_loading'))}</p>`;
  else {
    const w = warningOf(iso);
    const wl = warnLevel(iso);
    const url = w ? safeUrl(w.url, MOFA_HOSTS) : '';
    const summary = w ? (isEn() ? w.summary_en || w.summary_zh : w.summary_zh) : '';
    mofa = `<div class="c-level">${wbadge(wl)}<span>${esc(wLevelFull(wl, w?.source === 'mac'))}</span></div>${
      summary && app.role === 'public' ? `<p class="c-text">${esc(truncate(summary, 260))}</p>` : ''}${
      url ? `<p class="m-note"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(w?.source === 'mac' ? t('m_mac_link') : t('m_mofa_link'))} ↗</a>${w?.date ? ` · ${esc(fmtDay(w.date))}` : ''}</p>` : ''}`;
  }
  const mofaBlock = `<div class="c-block"><h3>${esc(t('m_mofa_title'))}</h3>${mofa}</div>`;
  let flights = '';
  if (app.role === 'officer') {
    needArrivals();
    let body;
    if (!arrivals) body = `<p class="c-text">${esc(t('arr_loading'))}</p>`;
    else {
      const list = (arrivals.flights || []).filter((f) => f.country === iso && Number.isFinite(bestTime(f)));
      const { up, past } = windowed(list, now, 0, false);
      const rows = [...up, ...past].slice(0, 10);
      body = rows.length ? `<ol class="f-list">${rows.map((f) => flightRow(f, now)).join('')}</ol>` : `<p class="c-text">${esc(t('m_no_flights_from'))}</p>`;
    }
    flights = `<div class="c-block"><h3>${esc(t('m_flights_from'))}<small class="f-stamp">${esc(t('arr_window_next_all'))} · ${esc(t('arr_window_past_all'))}</small></h3>${body}</div>`;
  }
  const items = (recent?.items || []).filter((it) => Array.isArray(it.countries) && it.countries.includes(iso)).slice(0, 5);
  const news = `<div class="c-block"><h3>${esc(t('m_news_country'))}</h3>${!recent ? `<p class="c-text">${esc(t('m_loading'))}</p>`
    : items.length ? `<ul class="n-list">${items.map(newsItem).join('')}</ul>` : `<p class="c-text">${esc(t('m_news_none'))}</p>`}</div>`;
  const actions = `<div class="c-actions">
      <a class="m-btn" href="./#/country/${esc(iso)}">${esc(t('m_on_map'))}</a>
      <a class="m-btn" href="trip.html#${esc(iso)}">${esc(t('m_trip_full'))}</a>
    </div>`;
  const blocks = app.role === 'officer' ? [cdc, flights, news, mofaBlock] : [cdc, mofaBlock, news];
  node.innerHTML = `<div class="c-back"><button type="button" class="m-link-btn" data-back>← ${esc(t('m_back'))}</button></div>
    <article class="m-card" data-testid="country-card" data-iso="${esc(iso)}">
      <div class="c-head"><div><h2>${esc(countryName(iso))}</h2><div class="alt">${esc(countryAltName(iso))}</div></div><span class="iso mono">${esc(iso)}</span></div>
      ${blocks.join('')}
      ${actions}
    </article>`;
}

function renderFlights() {
  const node = $('#view-flights');
  needArrivals();
  if (!arrivals) { node.innerHTML = `<p class="m-empty">${esc(t('arr_loading'))}</p>`; return; }
  const now = Date.now();
  const airports = Object.keys(arrivals.airports || {});
  if (airports.length && !airports.includes(app.fcfg.airport)) app.fcfg.airport = airports.includes('TPE') ? 'TPE' : airports[0];
  const { up, past } = windowed(airportFlights(), now);
  const risky = windowed(airportFlights(), now, app.fcfg.win, false);
  const nRisk = [...risky.up, ...risky.past].filter((f) => levelOf(f.country) >= 2).length;
  const gen = Date.parse(arrivals.tdx_updated || arrivals.generated_at || '');
  const ago = Number.isFinite(gen) ? Math.max(0, Math.round((now - gen) / 60000)) : null;
  const opts = (airports.length ? airports : [app.fcfg.airport]).map((code) => {
    const a = arrivals.airports?.[code];
    const name = a ? (isEn() ? a.name_en : a.name_zh) : code;
    return `<option value="${esc(code)}"${code === app.fcfg.airport ? ' selected' : ''}>${esc(name)} ${esc(code)}</option>`;
  }).join('');
  const list = (rows) => (rows.length ? `<ol class="f-list">${rows.map((f) => flightRow(f, now)).join('')}</ol>` : `<p class="m-empty">${esc(app.fcfg.risk ? t('arr_empty_risk') : t('arr_empty'))}</p>`);
  const winText = (dir) => (app.fcfg.win ? t(`arr_window_${dir}`, { n: app.fcfg.win }) : t(`arr_window_${dir}_all`));
  node.innerHTML = `
    <div class="f-tools">
      <label><span class="sr-only">${esc(t('arr_airport'))}</span><select data-fairport>${opts}</select></label>
      <div class="seg" role="group" aria-label="${esc(t('arr_win_label'))}">${WINDOWS.map((w) => `<button type="button" data-fwin="${w}" aria-pressed="${app.fcfg.win === w}">${
        esc(w ? t('arr_win_btn', { n: w }) : t('arr_win_all'))}</button>`).join('')}</div>
      <button type="button" class="f-risk" data-frisk aria-pressed="${app.fcfg.risk}">${esc(app.fcfg.risk ? t('arr_risk_on', { n: nRisk }) : t('arr_risk', { n: nRisk }))}</button>
    </div>
    <p class="f-stamp${ago != null && ago > 25 ? ' is-stale' : ''}">${ago == null ? '' : esc(t('m_updated', { n: ago }))} · <a href="arrivals.html?arr=${esc(app.fcfg.airport)}&amp;win=${app.fcfg.win || 'all'}">${esc(t('m_full_board'))} ↗</a></p>
    <h3 class="f-head">${esc(t('arr_upcoming'))} · ${esc(winText('next'))} · ${up.length}</h3>${list(up)}
    <h3 class="f-head">${esc(t('arr_arrived'))} · ${esc(winText('past'))} · ${past.length}</h3>${list(past)}`;
}

function renderNews() {
  const node = $('#view-news');
  needRecent();
  if (!recent) { node.innerHTML = `<p class="m-empty">${esc(t('m_loading'))}</p>`; return; }
  const onlyRisk = !!app.newsRisk;
  const items = (recent.items || []).filter((it) => !onlyRisk || (it.countries || []).some((c) => levelOf(c) >= 2));
  node.innerHTML = `<div class="f-tools"><div class="seg" role="group" aria-label="${esc(t('m_news_filter'))}">
      <button type="button" data-nrisk="0" aria-pressed="${!onlyRisk}">${esc(t('m_news_all'))}</button>
      <button type="button" data-nrisk="1" aria-pressed="${onlyRisk}">${esc(t('m_news_l2'))}</button></div>
      <span class="f-stamp">${esc(t('m_news_since', { n: recent.days || 60 }))}</span></div>
    ${items.length ? `<ul class="n-list">${items.map(newsItem).join('')}</ul>` : `<p class="m-empty">${esc(recent.failed ? t('m_load_failed') : t('m_none'))}</p>`}`;
}

function rerender() {
  if (!app.role) return;
  if (app.view === 'card') renderCard();
  else if (app.view === 'flights') renderFlights();
  else if (app.view === 'news') renderNews();
  else renderHome();
}

// ---------------------------------------------------------------- routing: #/c/XX · #/flights · #/news · (home)
function route() {
  const h = location.hash;
  let m;
  if ((m = /^#\/c\/([A-Z]{2})$/.exec(h))) { app.view = 'card'; app.iso = m[1]; }
  else if (h === '#/flights' && app.role === 'officer') app.view = 'flights';
  else if (h === '#/news') app.view = 'news';
  else app.view = 'home';
  for (const v of ['home', 'card', 'flights', 'news']) $(`#view-${v}`).hidden = app.view !== v;
  const tab = app.view === 'card' ? 'home' : app.view;
  document.querySelectorAll('.m-tab[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  rerender();
  if (app.view === 'card') document.title = `${countryName(app.iso)} · ${t('m_title')}`;
  else document.title = `${t('m_title')} · SafeTravel TW`;
}
let steps = 0; // in-page navigations: "back" returns through them, otherwise to the start view
const go = (hash) => {
  if (location.hash !== hash) { steps++; location.hash = hash; } else route();
  window.scrollTo({ top: 0 });
};

// ---------------------------------------------------------------- role
function setRole(role, { save = true } = {}) {
  app.role = role === 'officer' ? 'officer' : 'public';
  if (save) storageSet(ROLE_KEY, app.role);
  document.documentElement.dataset.role = app.role;
  $('.m-role .role-name').textContent = t(`m_role_${app.role}`);
  $('[data-testid="role-toggle"]').setAttribute('aria-label', t('m_role_switch', { role: t(`m_role_${app.role}`) }));
  $('[data-tab="flights"]').hidden = app.role !== 'officer';
  $('#m-q').placeholder = t(app.role === 'officer' ? 'm_search_ph_officer' : 'm_search_ph_public');
  document.querySelectorAll('.role-opt').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.role === app.role)));
  if (app.role !== 'officer' && location.hash === '#/flights') go('');
  else route();
}
function openRoleDialog() {
  const d = $('#role-dialog');
  d.hidden = false;
  (d.querySelector('[aria-pressed="true"]') || d.querySelector('.role-opt')).focus();
}

// ---------------------------------------------------------------- search
let countryIndex = null;
function countries() {
  if (countryIndex) return countryIndex;
  const isos = new Set([...Object.keys(state.data.alerts?.countries || {}), ...Object.keys(state.data.countries || {})].filter((x) => ISO2.test(x) && x !== 'TW'));
  countryIndex = [...isos].map((iso) => {
    const a = state.data.alerts?.countries?.[iso];
    const c = state.data.countries?.[iso];
    return { iso, keys: [...new Set([iso, a?.name_zh, a?.name_en, c?.zh, c?.en].filter(Boolean).map(norm))] };
  });
  return countryIndex;
}
function search(q) {
  const s = norm(q);
  if (!s) return [];
  const cjk = CJK.test(s);
  const out = [];
  for (const c of countries()) {
    let best = Infinity;
    for (const k of c.keys) {
      if (k === s) { best = 0; break; }
      if (k.startsWith(s)) best = Math.min(best, 1);
      else if ((cjk || s.length >= 3) && k.includes(s)) best = Math.min(best, 2);
    }
    if (best < Infinity && (cjk || s.length >= 2 || best === 0)) out.push({ kind: 'country', iso: c.iso, score: best });
  }
  for (const { place, score } of findPlaces(q, 5)) out.push({ kind: 'place', iso: place.iso, place, score: score + 0.5 });
  if (app.role === 'officer' && arrivals) {
    const fk = flightKey(q);
    if (fk.length >= 3 && /\d/.test(fk)) {
      for (const f of arrivals.flights || []) {
        if (![f.flight, ...(Array.isArray(f.codeshares) ? f.codeshares : [])].some((x) => flightKey(x).startsWith(fk))) continue;
        if (ISO2.test(f.country || '')) out.push({ kind: 'flight', iso: f.country, f, score: flightKey(f.flight) === fk ? -1 : 0.2 });
      }
    }
  }
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, 8);
}
function renderResults() {
  const list = $('#m-results');
  const input = $('#m-q');
  const q = input.value.trim();
  if (!q) { list.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
  list.innerHTML = app.results.length ? app.results.map((r, i) => {
    let name;
    let sub;
    let kind;
    if (r.kind === 'flight') {
      name = `${r.f.flight} · ${(isEn() ? r.f.from_en : r.f.from_zh) || r.f.from}`;
      sub = `${hm(bestTime(r.f))} · ${countryName(r.iso)}${r.f.gate ? ` · ${r.f.gate}` : ''}`;
      kind = t('m_kind_flight');
    } else if (r.kind === 'place') {
      name = placeName(r.place, isEn());
      sub = `${r.place.code ? `${r.place.code} · ` : ''}${countryName(r.iso)}`;
      kind = r.place.code ? t('m_kind_airport') : t('m_kind_city');
    } else {
      name = countryName(r.iso);
      sub = countryAltName(r.iso);
      kind = r.iso;
    }
    const idAttr = r.kind === 'flight' ? ` data-fid="${esc(r.f.id)}"` : '';
    return `<li role="option" id="m-opt-${i}" data-i="${i}" data-iso="${esc(r.iso)}"${idAttr} aria-selected="${i === app.active}">
        <span class="r-main"><span class="r-name">${esc(name)}</span><span class="r-sub">${esc(sub)}</span></span>${lvlBadge(r.iso, 'badge-sm')}<span class="r-kind mono">${esc(kind)}</span></li>`;
  }).join('') : `<li class="r-empty" role="presentation">${esc(t('m_search_none'))}</li>`;
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', app.active >= 0 ? `m-opt-${app.active}` : '');
}
function choose(i) {
  const r = app.results[i];
  if (!r) return;
  app.hotFlight = r.kind === 'flight' ? r.f.id : '';
  $('#m-q').value = '';
  app.results = [];
  renderResults();
  $('#m-q').blur();
  go(`#/c/${r.iso}`);
}

// ---------------------------------------------------------------- boot
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('[data-testid="theme-toggle"]');
  btn.setAttribute('aria-label', t(theme === 'dark' ? 'theme_toggle_label_dark' : 'theme_toggle_label_light'));
  btn.title = btn.getAttribute('aria-label');
}

async function main() {
  setLang(urlLang() || (storageGet(LANG_KEY) === 'en' ? 'en' : 'zh-Hant'));
  bindData(state.data);
  applyStatic();
  document.documentElement.classList.remove('i18n-pending');
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const textSize = bindTextSize($('[data-testid="textsize-toggle"]'), { t });
  try { Object.assign(app.fcfg, JSON.parse(storageGet(FCFG_KEY) || '{}')); } catch { /* ignore */ }
  if (!WINDOWS.includes(app.fcfg.win)) app.fcfg.win = 60;

  const [alerts, countriesJson] = await Promise.all([getJSON('alerts.json').catch(() => null), getJSON('countries.json').catch(() => null)]);
  state.data.alerts = alerts;
  state.data.countries = countriesJson;

  const qRole = new URLSearchParams(location.search).get('role');
  const stored = storageGet(ROLE_KEY);
  if (qRole === 'officer' || qRole === 'public') setRole(qRole);
  else if (stored === 'officer' || stored === 'public') setRole(stored, { save: false });
  else { app.role = null; openRoleDialog(); }

  window.addEventListener('hashchange', route);
  $('#role-dialog').addEventListener('click', (e) => {
    const b = e.target.closest('[data-role]');
    if (b) { $('#role-dialog').hidden = true; setRole(b.dataset.role); $('#m-q').focus({ preventScroll: true }); return; }
    if (e.target === $('#role-dialog') && app.role) $('#role-dialog').hidden = true;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#role-dialog').hidden && app.role) $('#role-dialog').hidden = true; });
  $('[data-testid="role-toggle"]').addEventListener('click', openRoleDialog);
  document.querySelectorAll('.m-tab[data-tab]').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab === 'home' ? '#/' : `#/${b.dataset.tab}`)));

  // clicks inside the views: countries, flights, "more" links, flight tools, news filter, back
  $('#m-main').addEventListener('click', (e) => {
    const back = e.target.closest('[data-back]');
    if (back) { if (steps > 0) { steps--; history.back(); } else go('#/'); return; }
    const more = e.target.closest('[data-go]');
    if (more) { go(`#/${more.dataset.go}`); return; }
    const w = e.target.closest('[data-fwin]');
    if (w) { app.fcfg.win = Number(w.dataset.fwin); storageSet(FCFG_KEY, JSON.stringify(app.fcfg)); renderFlights(); return; }
    if (e.target.closest('[data-frisk]')) { app.fcfg.risk = !app.fcfg.risk; storageSet(FCFG_KEY, JSON.stringify(app.fcfg)); renderFlights(); return; }
    const nr = e.target.closest('[data-nrisk]');
    if (nr) { app.newsRisk = nr.dataset.nrisk === '1'; renderNews(); return; }
    if (e.target.closest('a')) return;
    const row = e.target.closest('[data-iso]');
    if (row && ISO2.test(row.dataset.iso)) { app.hotFlight = row.dataset.fid || ''; go(`#/c/${row.dataset.iso}`); }
  });
  $('#m-main').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.f-row[data-iso]')) { e.preventDefault(); e.target.click(); }
  });
  $('#m-main').addEventListener('change', (e) => {
    if (e.target.matches('[data-fairport]')) { app.fcfg.airport = e.target.value; storageSet(FCFG_KEY, JSON.stringify(app.fcfg)); renderFlights(); }
  });

  const input = $('#m-q');
  const update = () => { app.results = search(input.value); app.active = app.results.length ? 0 : -1; renderResults(); };
  input.addEventListener('focus', () => { loadPlaces().then(() => { if (input.value.trim()) update(); }, () => {}); needArrivals(); }, { once: false });
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!app.results.length) return;
      e.preventDefault();
      app.active = (app.active + (e.key === 'ArrowDown' ? 1 : -1) + app.results.length) % app.results.length;
      renderResults();
    } else if (e.key === 'Enter') {
      if (app.active >= 0) { e.preventDefault(); choose(app.active); }
    } else if (e.key === 'Escape') {
      input.value = ''; app.results = []; renderResults();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => { $('#m-results').hidden = true; input.setAttribute('aria-expanded', 'false'); }, 150));
  $('#m-results').addEventListener('pointerdown', (e) => e.preventDefault()); // keep the focus in the box
  $('#m-results').addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) choose(+li.dataset.i); });

  $('[data-testid="lang-toggle"]').addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'zh-Hant' : 'en');
    storageSet(LANG_KEY, getLang() === 'en' ? 'en' : 'zh-Hant');
    syncUrlLang(getLang());
    applyStatic();
    applyTheme(document.documentElement.dataset.theme);
    textSize.refresh();
    if (app.role) setRole(app.role, { save: false });
    if (input.value.trim()) update();
  });
  $('[data-testid="theme-toggle"]').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    storageSet(THEME_KEY, next);
    applyTheme(next);
  });

  // officers: arrivals refresh every minute while the page is visible
  setInterval(() => {
    if (document.hidden || app.role !== 'officer') return;
    if (app.view === 'flights' || app.view === 'home' || app.view === 'card') needArrivals(true);
  }, 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && app.role === 'officer' && arrivals) needArrivals(true); });
  autoReload({ idleMs: 5 * 60_000 });
  window.__safetravel = { app, state };
  document.body.dataset.ready = '1';
}

main();
