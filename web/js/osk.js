// On-screen keyboard for touch kiosks that have no system keyboard (index.html, trip.html).
// Opt-in: ?osk=1 turns it on for the browser session (sessionStorage, so it survives moving between pages and
// auto-reloads), ?osk=0 turns it off. Without it this module does nothing and loads nothing else.
//
// Modes: 注音 (大千 layout; tone key or space ends a syllable, then pick a character; after a character the bar offers
// associated words, destination names first) and ABC (letters + digits). A row of common destinations replaces the
// search box's content in one tap. Keys type into the focused text / search field and fire the same `input` events
// and Enter keydown as a hardware keyboard, so the page's own search code needs no change.
// Zhuyin dictionary: vendor/zhuyin.json (scripts/build-zhuyin.py, McBopomofo data, MIT), fetched on first use.

const STORE = 'safetravel.osk';
const DICT_URL = 'vendor/zhuyin.json';

const INITIALS = 'ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙ';
const MEDIALS = 'ㄧㄨㄩ';
const FINALS = 'ㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦ';
const TONES = 'ˊˇˋ˙';

const ZH_ROWS = [
  ['ㄅ', 'ㄉ', 'ˇ', 'ˋ', 'ㄓ', 'ˊ', '˙', 'ㄚ', 'ㄞ', 'ㄢ', 'ㄦ'],
  ['ㄆ', 'ㄊ', 'ㄍ', 'ㄐ', 'ㄔ', 'ㄗ', 'ㄧ', 'ㄛ', 'ㄟ', 'ㄣ'],
  ['ㄇ', 'ㄋ', 'ㄎ', 'ㄑ', 'ㄕ', 'ㄘ', 'ㄨ', 'ㄜ', 'ㄠ', 'ㄤ'],
  ['ㄈ', 'ㄌ', 'ㄏ', 'ㄒ', 'ㄖ', 'ㄙ', 'ㄩ', 'ㄝ', 'ㄡ', 'ㄥ'],
];
const EN_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '-'],
  ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', "'", '.'],
];
const WORDS = {
  zh: ['日本', '韓國', '泰國', '越南', '中國大陸', '香港', '澳門', '菲律賓', '印尼', '馬來西亞', '新加坡', '柬埔寨',
    '印度', '美國', '加拿大', '澳洲', '英國', '法國', '德國'],
  en: ['Japan', 'Korea', 'Thailand', 'Vietnam', 'China', 'Hong Kong', 'Macao', 'Philippines', 'Indonesia',
    'Malaysia', 'Singapore', 'Cambodia', 'India', 'United States', 'Canada', 'Australia', 'United Kingdom',
    'France', 'Germany'],
};
const TEXT = {
  zh: {
    abc: 'ABC', zhuyin: '注音', space: '空白', tone1: '一聲', clear: '清除', enter: '確定', hide: '收起',
    words: '常用', loading: '載入字典中…', none: '沒有這個音，請修改注音', hint: '輸入注音，再按聲調或空白（一聲）',
    failed: '字典載入失敗', bksp: '刪除', label: '螢幕鍵盤',
  },
  en: {
    abc: 'ABC', zhuyin: '注音', space: 'space', tone1: 'tone 1', clear: 'Clear', enter: 'Enter', hide: 'Hide',
    words: 'Popular', loading: 'Loading dictionary…', none: 'No such syllable', hint: 'Type Zhuyin, then a tone key or space',
    failed: 'Dictionary failed to load', bksp: 'Delete', label: 'On-screen keyboard',
  },
};

function enabled() {
  let q = null;
  try { q = new URLSearchParams(location.search).get('osk'); } catch (e) { /* ignore */ }
  if (q === '1' || q === '0') {
    try { if (q === '1') sessionStorage.setItem(STORE, '1'); else sessionStorage.removeItem(STORE); } catch (e) { /* ignore */ }
    return q === '1';
  }
  try { return sessionStorage.getItem(STORE) === '1'; } catch (e) { return false; }
}

const EDITABLE = new Set(['text', 'search', 'url', 'email', 'tel', '']);
function editable(el) {
  if (!el || el.disabled || el.readOnly) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && EDITABLE.has((el.getAttribute('type') || '').toLowerCase());
}

function init() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'osk.css';
  document.head.appendChild(link);

  const lang = () => (document.documentElement.lang === 'en' ? 'en' : 'zh');
  const tx = (k) => TEXT[lang()][k];

  let target = null;          // the field being typed into
  let mode = lang() === 'en' ? 'en' : 'zh';
  let shift = false;
  let syl = { i: '', m: '', f: '' }; // Zhuyin syllable being composed
  let cands = [];             // [{ text, kind: 'char' | 'assoc' }]
  let note = '';              // message in the candidate bar
  let dict = null;
  let dictLoading = null;

  const root = document.createElement('div');
  root.className = 'osk';
  root.hidden = true;
  root.setAttribute('role', 'group');
  root.dataset.testid = 'osk';
  document.body.appendChild(root);

  function loadDict() {
    if (!dictLoading) {
      dictLoading = fetch(DICT_URL)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((d) => { dict = d; if (note === tx('loading')) note = ''; render(); })
        .catch(() => { dictLoading = null; note = tx('failed'); render(); });
    }
    return dictLoading;
  }

  // ---------- editing the target field ----------
  function fire(type = 'insertText', data = null) {
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: type, data }));
  }
  function insert(text) {
    if (!target) return;
    const v = target.value;
    const s = target.selectionStart ?? v.length;
    const e = target.selectionEnd ?? s;
    target.value = v.slice(0, s) + text + v.slice(e);
    const pos = s + text.length;
    try { target.setSelectionRange(pos, pos); } catch (err) { /* ignore */ }
    fire('insertText', text);
  }
  function backspace() {
    if (!target) return;
    const v = target.value;
    let s = target.selectionStart ?? v.length;
    const e = target.selectionEnd ?? s;
    if (s === e) {
      if (!s) return;
      s -= (s >= 2 && /[\uDC00-\uDFFF]/.test(v[s - 1])) ? 2 : 1;
    }
    target.value = v.slice(0, s) + v.slice(e);
    try { target.setSelectionRange(s, s); } catch (err) { /* ignore */ }
    fire('deleteContentBackward');
  }
  function replaceAll(text) {
    if (!target) return;
    target.value = text;
    try { target.setSelectionRange(text.length, text.length); } catch (err) { /* ignore */ }
    fire('insertReplacementText', text);
  }
  function enter() {
    if (!target) return;
    const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', o));
    target?.dispatchEvent(new KeyboardEvent('keyup', o));
  }

  // ---------- Zhuyin composition ----------
  const composing = () => !!(syl.i || syl.m || syl.f);
  const sylText = () => syl.i + syl.m + syl.f;
  function resetSyl() { syl = { i: '', m: '', f: '' }; }

  function zhKey(k) {
    if (TONES.includes(k)) { finish(k); return; }
    if (INITIALS.includes(k)) syl.i = k;
    else if (MEDIALS.includes(k)) syl.m = k;
    else if (FINALS.includes(k)) syl.f = k;
    cands = [];
    note = '';
    if (!dict) { loadDict(); if (!dict) note = tx('loading'); }
    render();
  }
  function finish(tone) { // tone: '' (first tone), 'ˊ' 'ˇ' 'ˋ' '˙'
    if (!composing()) return;
    if (!dict) { loadDict(); note = tx('loading'); render(); return; }
    const reading = sylText() + (tone || '');
    const chars = dict.c?.[reading] || '';
    if (!chars) { cands = []; note = tx('none'); render(); return; }
    cands = Array.from(chars, (c) => ({ text: c, kind: 'char' }));
    note = '';
    resetSyl();
    render(reading);
  }
  function pick(c) {
    insert(c.text);
    const last = c.text[c.text.length - 1];
    const next = c.kind === 'char' ? (dict?.a?.[last] || []) : [];
    cands = next.map((t) => ({ text: t, kind: 'assoc' }));
    note = '';
    render();
  }

  // ---------- key handling ----------
  function press(k) {
    switch (k) {
      case 'mode':
        mode = mode === 'zh' ? 'en' : 'zh';
        resetSyl(); cands = []; note = ''; shift = false;
        if (mode === 'zh') loadDict();
        render();
        return;
      case 'shift': shift = !shift; render(); return;
      case 'space':
        if (mode === 'zh' && composing()) { finish(''); return; }
        cands = []; insert(' '); render(); return;
      case 'bksp':
        if (mode === 'zh' && composing()) {
          if (syl.f) syl.f = ''; else if (syl.m) syl.m = ''; else syl.i = '';
          note = ''; render(); return;
        }
        if (cands.length) { cands = []; render(); return; } // first tap dismisses the suggestions
        backspace(); return;
      case 'clear': resetSyl(); cands = []; note = ''; replaceAll(''); render(); return;
      case 'enter':
        if (mode === 'zh' && composing()) { finish(''); return; }
        if (cands.length && cands[0].kind === 'char') { pick(cands[0]); return; }
        cands = []; render(); enter(); return;
      case 'hide': hide(true); return;
      default:
        if (mode === 'zh') { zhKey(k); return; }
        insert(shift ? k.toUpperCase() : k);
        if (shift) { shift = false; render(); }
    }
  }

  // ---------- rendering ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const key = (k, label, cls = '') => `<button type="button" class="osk-key ${cls}" data-k="${esc(k)}">${esc(label)}</button>`;

  function render(reading = '') {
    const L = lang();
    root.setAttribute('aria-label', tx('label'));
    const rows = (mode === 'zh' ? ZH_ROWS : EN_ROWS).map((row) => `<div class="osk-row">${row.map((k) => {
      if (k === 'shift') return key('shift', '⇧', `osk-fn${shift ? ' on' : ''}`);
      const label = mode === 'en' && shift ? k.toUpperCase() : k;
      return key(k, label, TONES.includes(k) ? 'osk-tone' : '');
    }).join('')}</div>`).join('');
    const spaceLabel = mode === 'zh' && composing() ? tx('tone1') : tx('space');
    const bottom = `<div class="osk-row osk-bottom">
      ${key('mode', mode === 'zh' ? tx('abc') : tx('zhuyin'), 'osk-fn osk-mode')}
      ${key('space', spaceLabel, 'osk-space')}
      ${key('bksp', '⌫', 'osk-fn osk-bksp')}
      ${key('clear', tx('clear'), 'osk-fn')}
      ${key('enter', tx('enter'), 'osk-fn osk-enter')}
      ${key('hide', `${tx('hide')} ▾`, 'osk-fn osk-hide')}
    </div>`;
    const comp = mode === 'zh' && (composing() || reading)
      ? `<span class="osk-comp" aria-live="polite">${esc(composing() ? sylText() : reading)}</span>` : '';
    let bar;
    if (cands.length) {
      bar = cands.map((c, i) => `<button type="button" class="osk-cand ${c.kind === 'assoc' ? 'osk-assoc' : ''}" data-c="${i}">${
        c.kind === 'assoc' ? '…' : ''}${esc(c.text)}</button>`).join('');
    } else {
      bar = `<span class="osk-note">${esc(note || (mode === 'zh' ? tx('hint') : ''))}</span>`;
    }
    const words = WORDS[L]; // follow the page language: the search matches both, the page shows this one
    root.innerHTML = `
      <div class="osk-words"><span class="osk-words-label">${esc(tx('words'))}</span><div class="osk-scroll">${
        words.map((w) => `<button type="button" class="osk-word" data-w="${esc(w)}">${esc(w)}</button>`).join('')}</div></div>
      <div class="osk-bar">${comp}<div class="osk-scroll osk-cands">${bar}</div></div>
      <div class="osk-keys osk-${mode}">${rows}${bottom}</div>`;
  }

  // keep the field focused: never let a tap on the keyboard take the focus
  root.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const b = e.target.closest('button');
    if (b) {
      b.classList.add('down');
      const up = () => { b.classList.remove('down'); };
      b.addEventListener('pointerup', up, { once: true });
      b.addEventListener('pointercancel', up, { once: true });
      b.addEventListener('pointerleave', up, { once: true });
    }
  });
  root.addEventListener('mousedown', (e) => e.preventDefault());
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const k = b.dataset.k;
    if (k) press(k);
    else if (b.dataset.c) { const c = cands[+b.dataset.c]; if (c) pick(c); }
    else if (b.dataset.w) { resetSyl(); cands = []; note = ''; replaceAll(b.dataset.w); render(); }
    // Enter may let the page close the search on purpose (it blurs the field): do not pull the focus back then
    if (k !== 'enter' && k !== 'hide' && target && document.activeElement !== target) target.focus({ preventScroll: true });
  });

  // ---------- show / hide ----------
  function show(el) {
    target = el;
    if (el.inputMode !== 'none') el.inputMode = 'none'; // no system keyboard on top of ours
    if (root.hidden) {
      resetSyl(); cands = []; note = '';
      if (mode === 'zh') loadDict();
      render();
      root.hidden = false;
      document.documentElement.classList.add('osk-open');
    }
    requestAnimationFrame(() => { // keep the field above the keyboard
      const r = el.getBoundingClientRect();
      const top = root.getBoundingClientRect().top;
      if (r.bottom > top - 8) el.scrollIntoView({ block: 'center' });
    });
  }
  function hide(blur = false) {
    root.hidden = true;
    document.documentElement.classList.remove('osk-open');
    const t = target;
    target = null;
    if (blur && t && document.activeElement === t) t.blur();
  }

  document.addEventListener('focusin', (e) => { if (editable(e.target)) show(e.target); });
  document.addEventListener('focusout', () => {
    setTimeout(() => { if (!editable(document.activeElement)) hide(); }, 0);
  });
  // the language toggle re-labels the keys
  new MutationObserver(() => { if (!root.hidden) render(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
}

if (enabled()) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}
