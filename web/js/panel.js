// Country detail panel: advisories, AI overview (typewriter), epidemic timeline.
import { state, emit, levelOf, alertsOf, routesTo, groupAlerts } from './state.js';
import {
  t, isEn, countryName, countryAltName, diseaseName, levelFull, levelShort, levelInstruction,
  badge, fmtDay, fmtAge, fmtNum, pick,
} from './i18n.js';
import { esc, clean, reducedMotion, $ } from './util.js';

const PAGE = 20;
const GROUPS_SHOWN = 5; // advisory groups visible before "show all"
const AREA_CHIPS = 6; // area chips visible per group before "+N"

export function createPanel({ root, map }) {
  const body = $('.panel-body', root);
  const head = $('.panel-head', root);
  let iso = null;
  let shown = PAGE;
  let typer = null;
  let lastFocus = null;
  let hideTimer = 0;
  let showAllGroups = false;
  const expandedAreas = new Set();

  // Delegated handlers survive re-renders (language switch, digests arriving).
  body.addEventListener('click', (ev) => {
    const more = ev.target.closest('.area-more');
    if (more) {
      expandedAreas.add(+more.dataset.group);
      const ul = more.closest('.area-chips');
      ul.classList.add('is-open');
      more.parentElement.remove();
      return;
    }
    const all = ev.target.closest('.show-all-groups');
    if (all) {
      showAllGroups = true;
      body.querySelectorAll('.adv.is-extra').forEach((li) => li.classList.remove('is-extra'));
      all.remove();
    }
  });

  $('.panel-close', root).addEventListener('click', () => close());
  // Any hands-on use of the panel holds the spotlight auto-tour for a while.
  const touched = () => emit('user:interact');
  ['pointerdown', 'keydown'].forEach((type) => root.addEventListener(type, touched));
  ['wheel', 'touchstart'].forEach((type) => root.addEventListener(type, touched, { passive: true }));

  function aiChip(ov) {
    if (!ov) return '';
    const meta = state.data.meta;
    const ai = ov.ai === true || (ov.ai !== false && (meta?.counts?.ai_translated ?? 0) > 0);
    return ai
      ? `<span class="chip chip-ai"><i aria-hidden="true">✦</i>${esc(t('panel_ai_chip'))}</span>`
      : `<span class="chip chip-auto">${esc(t('panel_auto_chip'))}</span>`;
  }

  function renderHead() {
    const lvl = levelOf(iso);
    const flights = routesTo(iso);
    const dep = flights.reduce((s, r) => s + (r.departures || 0), 0);
    const items = state.byCountry.get(iso);
    head.className = `panel-head lvl-${lvl}`;
    head.innerHTML = `
      <div class="panel-kicker"><span class="mono">ISO ${esc(iso)}</span><span class="sep">//</span><span>${esc(t('panel_max_level'))}</span></div>
      <div class="panel-title-row">
        ${badge(lvl, lvl ? levelShort(lvl) : t('level_short_0'), 'badge-lg')}
        <div class="panel-names">
          <h2 id="panel-title" tabindex="-1">${esc(countryName(iso))}</h2>
          <p class="panel-alt">${esc(countryAltName(iso))}</p>
        </div>
      </div>
      ${lvl ? `<p class="panel-instr lvl-text-${lvl}">${esc(levelFull(lvl))} — ${esc(levelInstruction(lvl))}</p>` : ''}
      <dl class="panel-stats">
        <div><dt>${esc(t('panel_stat_advisories'))}</dt><dd class="mono">${fmtNum(alertsOf(iso).length)}</dd></div>
        <div><dt>${esc(t('panel_stat_epidemics'))}</dt><dd class="mono">${items ? fmtNum(items.length) : state.epidemicsStatus === 'loading' ? '…' : state.epidemicsStatus === 'ready' ? '0' : '—'}</dd></div>
        <div><dt>${esc(t('panel_stat_flights'))}</dt><dd class="mono">${fmtNum(dep)}</dd></div>
      </dl>`;
  }

  function areaLabel(r) {
    return clean(isEn() ? r.area_en || r.area_zh : r.area_zh || r.area_en);
  }

  function areaChip(r, extra = false) {
    return `<li class="area-chip${extra ? ' is-extra' : ''}">${esc(areaLabel(r))}${r.iso_sub ? `<span class="mono">${esc(r.iso_sub)}</span>` : ''}</li>`;
  }

  function renderGroup(g, gi) {
    const single = g.rows.length === 1;
    const lone = single && g.areas.length === 1 ? g.areas[0] : null; // one sub-national row: inline, as before
    const showChips = !single && g.areas.length > 0;
    let chips = '';
    if (showChips) {
      const open = expandedAreas.has(gi);
      const list = [];
      if (g.national) list.push(`<li class="area-chip area-whole">${esc(t('panel_area_whole'))}</li>`);
      g.areas.forEach((r, i) => list.push(areaChip(r, i >= AREA_CHIPS)));
      const rest = g.areas.length - AREA_CHIPS;
      if (rest > 0 && !open) {
        list.push(`<li class="area-more-li"><button type="button" class="area-more" data-group="${gi}" aria-label="${esc(t('panel_areas_more_label', { n: rest }))}">${esc(t('panel_areas_more', { n: rest }))}</button></li>`);
      }
      chips = `<ul class="area-chips${open ? ' is-open' : ''}">${list.join('')}</ul>`;
    }
    return `
        <li class="adv lvl-${g.level}${gi >= GROUPS_SHOWN && !showAllGroups ? ' is-extra' : ''}">
          <div class="adv-top">${badge(g.level)}<span class="adv-age mono">${esc(fmtAge(g.effective))}</span></div>
          <div class="adv-disease">${esc(diseaseName(g.disease))}${lone ? `<span class="adv-area">${esc(areaLabel(lone))}${lone.iso_sub ? ` <span class="mono">${esc(lone.iso_sub)}</span>` : ''}</span>` : ''}${showChips ? `<span class="adv-count mono">${esc(t('panel_areas', { n: g.areas.length }))}</span>` : ''}</div>
          <div class="adv-foot"><span class="adv-instr">${esc(levelInstruction(g.level))}</span><span class="adv-meta">${esc(t('panel_effective'))} <time class="mono" datetime="${esc(g.effective)}">${esc(fmtDay(g.effective))}</time></span></div>
          ${chips}
        </li>`;
  }

  function renderAdvisories() {
    const list = alertsOf(iso);
    const groups = groupAlerts(iso);
    const globals = state.data.alerts?.global || [];
    const items = groups.map(renderGroup).join('');
    const hidden = showAllGroups ? 0 : Math.max(0, groups.length - GROUPS_SHOWN);
    const globalNote = globals.length
      ? `<p class="global-note"><i aria-hidden="true">ⓘ</i>${esc(t('panel_global_note', {
        items: globals.map((g) => t('panel_global_item', {
          disease: diseaseName(g.disease), level: levelFull(g.level), date: fmtDay(g.effective), n: fmtNum(g.countries),
        })).join(isEn() ? '; ' : '；'),
      }))}</p>`
      : '';
    return `
      <section class="psec" aria-labelledby="psec-a">
        <h3 id="psec-a"><span class="psec-idx mono">A</span>${esc(t('panel_sec_advisories'))}<span class="count mono">${fmtNum(groups.length)}</span></h3>
        ${list.length ? `<ol class="adv-list">${items}</ol>` : `<p class="empty">${esc(t('panel_no_advisory'))}</p>`}
        ${hidden ? `<button type="button" class="btn show-all-groups">${esc(t('panel_show_all', { n: groups.length }))}</button>` : ''}
        ${globalNote}
      </section>`;
  }

  function renderAI() {
    let inner;
    let chip = '';
    if (state.epidemicsStatus !== 'ready') {
      inner = state.epidemicsStatus === 'error'
        ? `<p class="empty">${esc(t('panel_ai_none'))}</p>`
        : `<div class="skeleton" aria-busy="true"><span></span><span></span><span></span><em>${esc(t('panel_ai_loading'))}</em></div>`;
    } else {
      const ov = state.data.epidemics?.overviews?.[iso];
      if (ov && (ov.zh || ov.en)) {
        chip = aiChip(ov);
        inner = `<p class="ai-text"><span class="tw" data-full=""></span><span class="caret" aria-hidden="true"></span></p>
          ${ov.updated ? `<p class="ai-meta">${esc(t('panel_ai_meta', { date: fmtDay(ov.updated), n: fmtNum(ov.items ?? 0) }))}</p>` : ''}`;
      } else {
        inner = `<p class="empty">${esc(t('panel_ai_none'))}</p>`;
      }
    }
    return `
      <section class="psec psec-ai" aria-labelledby="psec-b">
        <h3 id="psec-b"><span class="psec-idx mono">B</span>${esc(t('panel_sec_ai'))}${chip}</h3>
        ${inner}
      </section>`;
  }

  function timelineItems() {
    return state.byCountry.get(iso) || [];
  }

  function renderTimelineList(from, to) {
    return timelineItems().slice(from, to).map((it) => {
      const head = pick(it, 'headline');
      const sum = pick(it, 'summary');
      const desc = pick(it, 'description');
      const dis = isEn() ? clean(it.disease_en || it.disease_zh) : clean(it.disease_zh);
      const showDesc = desc.text && desc.text !== sum.text;
      const zhOnly = isEn() && (head.fallback || sum.fallback);
      return `
        <li class="tl-item">
          <time class="tl-date mono" datetime="${esc(it.date)}">${esc(fmtDay(it.date, 'short'))}</time>
          <div class="tl-body">
            <div class="tl-tags">${dis ? `<span class="tag">${esc(dis)}</span>` : ''}${zhOnly ? `<span class="tag tag-muted">${esc(t('panel_zh_only'))}</span>` : ''}</div>
            <h4${isEn() && head.fallback ? ' lang="zh-Hant"' : ''}>${esc(head.text)}</h4>
            ${sum.text ? `<p class="tl-sum">${esc(sum.text)}</p>` : ''}
            ${showDesc ? `<details><summary>${esc(t('panel_full_text'))}</summary><p>${esc(desc.text)}</p></details>` : ''}
            ${it.url ? `<a class="tl-link" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(t('panel_source'))} ↗</a>` : ''}
          </div>
        </li>`;
    }).join('');
  }

  function renderTimeline() {
    let inner;
    if (state.epidemicsStatus !== 'ready') {
      inner = state.epidemicsStatus === 'error'
        ? `<p class="empty">${esc(t('panel_timeline_none'))}</p>`
        : '<div class="skeleton" aria-busy="true"><span></span><span></span><span></span><span></span></div>';
    } else {
      const items = timelineItems();
      inner = items.length
        ? `<ol class="timeline">${renderTimelineList(0, shown)}</ol>${items.length > shown ? `<button type="button" class="btn more-btn">${esc(t('panel_more', { n: items.length - shown }))}</button>` : ''}`
        : `<p class="empty">${esc(t('panel_timeline_none'))}</p>`;
    }
    const n = state.epidemicsStatus === 'ready' ? timelineItems().length : null;
    return `
      <section class="psec psec-tl" aria-labelledby="psec-c">
        <h3 id="psec-c"><span class="psec-idx mono">C</span>${esc(t('panel_sec_timeline'))}${n != null ? `<span class="count mono">${esc(t('panel_timeline_count', { n }))}</span>` : ''}</h3>
        ${inner}
      </section>`;
  }

  function startTypewriter() {
    if (typer) { clearInterval(typer); typer = null; }
    const tw = $('.tw', body);
    if (!tw) return;
    const ov = state.data.epidemics?.overviews?.[iso];
    const full = clean(isEn() ? ov?.en || ov?.zh : ov?.zh || ov?.en);
    const caret = $('.caret', body);
    if (reducedMotion()) {
      tw.textContent = full;
      caret?.classList.add('done');
      return;
    }
    const chars = Array.from(full);
    let i = 0;
    const perTick = Math.max(1, Math.ceil(chars.length / 160));
    typer = setInterval(() => {
      i = Math.min(chars.length, i + perTick);
      tw.textContent = chars.slice(0, i).join('');
      if (i >= chars.length) {
        clearInterval(typer);
        typer = null;
        caret?.classList.add('done');
      }
    }, 22);
  }

  function render() {
    if (!iso) return;
    renderHead();
    body.innerHTML = renderAdvisories() + renderAI() + renderTimeline();
    startTypewriter();
    const more = $('.more-btn', body);
    if (more) more.addEventListener('click', onMore);
  }

  function onMore(ev) {
    const items = timelineItems();
    const ol = $('.timeline', body);
    ol.insertAdjacentHTML('beforeend', renderTimelineList(shown, shown + PAGE));
    shown += PAGE;
    if (shown >= items.length) ev.currentTarget.remove();
    else ev.currentTarget.textContent = t('panel_more', { n: items.length - shown });
  }

  function open(code, { fly = true, focus = true } = {}) {
    const up = String(code || '').toUpperCase();
    if (!up) return false;
    const known = state.data.alerts?.countries?.[up] || state.data.countries?.[up] || map.has(up);
    if (!known) return false;
    const changed = up !== iso;
    iso = up;
    state.selected = up;
    if (changed) {
      shown = PAGE;
      showAllGroups = false;
      expandedAreas.clear();
    }
    clearTimeout(hideTimer);
    if (!document.activeElement || !root.contains(document.activeElement)) lastFocus = document.activeElement;
    root.hidden = false;
    requestAnimationFrame(() => root.classList.add('is-open'));
    document.body.classList.add('panel-open');
    render();
    body.scrollTop = 0;
    map.setSelected(up);
    if (fly) {
      const narrow = window.innerWidth < 760;
      map.flyTo(up, {
        pad: narrow ? { top: 140, bottom: window.innerHeight * 0.62 } : { right: root.offsetWidth + 24, top: 150, left: 40, bottom: 60 },
        maxScale: 4.5,
      });
    }
    const want = `#/country/${up}`;
    if (location.hash !== want) history.replaceState(null, '', want);
    if (focus) $('#panel-title', root)?.focus({ preventScroll: true });
    emit('panel:open', up);
    return true;
  }

  function close() {
    if (!iso) return;
    iso = null;
    state.selected = null;
    if (typer) { clearInterval(typer); typer = null; }
    root.classList.remove('is-open');
    document.body.classList.remove('panel-open');
    hideTimer = setTimeout(() => { root.hidden = true; }, reducedMotion() ? 0 : 320);
    map.setSelected(null);
    if (location.hash.startsWith('#/country/')) history.replaceState(null, '', location.pathname + location.search);
    if (lastFocus && document.contains(lastFocus) && lastFocus !== document.body) lastFocus.focus({ preventScroll: true });
    emit('panel:close');
  }

  return {
    open,
    close,
    isOpen: () => !!iso,
    current: () => iso,
    refresh: () => { if (iso) render(); },
  };
}
