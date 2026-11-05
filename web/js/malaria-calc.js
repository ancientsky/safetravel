// Malaria prophylaxis calculator — pure logic (no DOM), shared by malaria.html and its tests.
//
// Every regimen, dose, contraindication and caution below is taken from Taiwan CDC's page
// 「瘧疾預防用藥」(國內現用藥品簡介, last updated 2026-02-05):
// https://www.cdc.gov.tw/Category/ListContent/YipvR33b32K-dsMI2eIrIg?uaid=ZSgu_4NoQ7NTp0zZ-HC8rg
// Where that page leaves a decision to the doctor (Malarone for < 40 kg — Taiwan has no paediatric tablet;
// doxycycline 2.2 mg/kg for children; mefloquine ≤ 9 kg compounded by a pharmacist) the calculator gives no tablet
// count and says so. It never chooses a drug: it lists what CDC's rules allow for this traveller and trip.

export const SOURCE_URL = 'https://www.cdc.gov.tw/Category/ListContent/YipvR33b32K-dsMI2eIrIg?uaid=ZSgu_4NoQ7NTp0zZ-HC8rg';
export const SOURCE_DATE = '2026-02-05';

export const DRUGS = [
  {
    id: 'atq',
    zh: '阿托奎酮與氯胍混合製劑',
    en: 'Atovaquone/proguanil',
    brand: 'Malarone®',
    tabletZh: '成人錠：Atovaquone 250 mg／Proguanil 100 mg',
    tabletEn: 'adult tablet: atovaquone 250 mg / proguanil 100 mg',
    freq: 'daily',
    lead: [1, 2],      // days before arriving in the risk area
    afterDays: 7,      // keep taking it for 7 days after leaving
  },
  {
    id: 'dox',
    zh: '去氧羥四黴素',
    en: 'Doxycycline',
    brand: '',
    tabletZh: '100 mg 錠',
    tabletEn: '100 mg tablet',
    freq: 'daily',
    lead: [1, 2],
    afterDays: 28,
  },
  {
    id: 'mef',
    zh: '美爾奎寧',
    en: 'Mefloquine',
    brand: '',
    tabletZh: '250 mg 錠（228 mg base）',
    tabletEn: '250 mg tablet (228 mg base)',
    freq: 'weekly',
    lead: [2, 3],      // weeks before arriving
    afterDays: 28,
  },
];

const DAY = 864e5;

/** 'YYYY-MM-DD' (or the date part of 'YYYY-MM-DDTHH:MM') → UTC midnight ms; NaN when invalid. */
export function dayMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return NaN;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : NaN;
}
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (s, n) => isoDay(dayMs(s) + n * DAY);
export const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / DAY);

/**
 * Itinerary legs → the risk window.
 * leg: { arrive: 'YYYY-MM-DDTHH:MM', depart: '…', risk: 'drug'|'bites'|'none'|'unknown', visit: 'yes'|'no'|'unsure',
 *        mef: bool }
 * A leg needs preventive medicine when CDC asks a doctor to assess it ("drug") and the traveller goes — or may go —
 * to the risk areas CDC describes; "unknown" (no CDC text) is treated the same, to be safe.
 */
export function riskWindow(legs) {
  const risky = legs.filter((l) => (l.risk === 'drug' || l.risk === 'unknown') && l.visit !== 'no'
    && Number.isFinite(dayMs(l.arrive)) && Number.isFinite(dayMs(l.depart)));
  if (!risky.length) return null;
  const start = risky.map((l) => l.arrive.slice(0, 10)).sort()[0];
  const end = risky.map((l) => l.depart.slice(0, 10)).sort().at(-1);
  return { start, end, days: daysBetween(start, end) + 1, mefResistant: risky.some((l) => l.mef), legs: risky };
}

/** Overall verdict for the trip: 'need' | 'avoid-areas' | 'bites' | 'none' | 'incomplete'. */
export function verdict(legs) {
  if (!legs.length || legs.some((l) => !l.risk || !Number.isFinite(dayMs(l.arrive)) || !Number.isFinite(dayMs(l.depart)))) return 'incomplete';
  if (riskWindow(legs)) return 'need';
  if (legs.some((l) => l.risk === 'drug')) return 'avoid-areas';
  if (legs.some((l) => l.risk === 'bites')) return 'bites';
  return 'none';
}

/** Per-dose amount for this traveller: { tablets: number|null, mg: number|null, note: i18n key|null }. */
export function doseFor(drug, p) {
  const adult = p.age >= 18;
  const w = p.weight;
  if (drug.id === 'atq') {
    if (adult && !(w < 40)) return { tablets: 1, mg: null, note: null };
    if (w >= 40) return { tablets: 1, mg: null, note: null };
    if (!(w > 0)) return { tablets: null, mg: null, note: 'dose_need_weight' };
    return { tablets: null, mg: null, note: 'dose_atq_child' };   // < 40 kg: weight-adjusted, no TW paediatric tablet
  }
  if (drug.id === 'dox') {
    if (adult) return { tablets: 1, mg: 100, note: null };
    if (!(w > 0)) return { tablets: null, mg: null, note: 'dose_need_weight' };
    const mg = Math.min(100, Math.round(2.2 * w * 10) / 10);
    return mg >= 100 ? { tablets: 1, mg: 100, note: null } : { tablets: null, mg, note: 'dose_dox_child' };
  }
  // mefloquine
  if (adult) return { tablets: 1, mg: 250, note: null };
  if (!(w > 0)) return { tablets: null, mg: null, note: 'dose_need_weight' };
  if (w <= 9) return { tablets: null, mg: Math.round(5 * w * 10) / 10, note: 'dose_mef_infant' };
  if (w <= 19) return { tablets: 0.25, mg: null, note: null };
  if (w <= 30) return { tablets: 0.5, mg: null, note: null };
  if (w <= 45) return { tablets: 0.75, mg: null, note: null };
  return { tablets: 1, mg: null, note: null };
}

/**
 * Can this drug be considered? → { status: 'ok'|'caution'|'no'|'covered', reasons: [i18n keys] }
 * p: { age, weight, pregnant: 'no'|'yes'|'planning', breastfeeding, infantUnder5, psych, seizure, arrhythmia, renal,
 *      liver, yeast, bupropion, precision, acneDox, hiv, allergyMef, allergyDox, allergyAtq }
 */
export function assess(drug, p, win) {
  const no = [];
  const caution = [];
  if (drug.id === 'atq') {
    if (p.pregnant === 'yes') no.push('r_atq_pregnant');
    if (p.breastfeeding && p.infantUnder5) no.push('r_atq_bf');
    if (p.renal) no.push('r_atq_renal');
    if (p.allergyAtq) no.push('r_allergy');
    if (p.weight > 0 && p.weight < 5) no.push('r_atq_5kg');
    if (p.weight > 0 && p.weight < 40 && !no.length) caution.push('r_atq_40kg');
    if (p.hiv) caution.push('r_hiv');
  } else if (drug.id === 'dox') {
    if (p.acneDox) return { status: 'covered', reasons: ['r_dox_acne'] };
    if (p.pregnant === 'yes') no.push('r_dox_pregnant');
    if (p.age < 8) no.push('r_dox_child');
    if (p.allergyDox) no.push('r_allergy');
    if (p.breastfeeding) caution.push('r_dox_bf');
    if (p.liver) caution.push('r_dox_liver');
    if (p.yeast) caution.push('r_dox_yeast');
    caution.push('r_dox_sun');
  } else {
    if (win?.mefResistant) no.push('r_mef_resistant');
    if (p.psych) no.push('r_mef_psych');
    if (p.seizure) no.push('r_mef_seizure');
    if (p.allergyMef) no.push('r_allergy');
    if (p.arrhythmia) caution.push('r_mef_arrhythmia');
    if (p.bupropion) caution.push('r_mef_bupropion');
    if (p.precision) caution.push('r_mef_precision');
    if (p.hiv) caution.push('r_hiv');
  }
  if (p.pregnant === 'planning') caution.push('r_planning');
  if (no.length) return { status: 'no', reasons: no };
  return { status: caution.some((r) => r !== 'r_dox_sun') ? 'caution' : 'ok', reasons: caution };
}

/**
 * Dose dates for a drug over the risk window. lead: days (daily drugs) or weeks (mefloquine).
 * Daily: from `lead` days before arrival through `afterDays` after leaving, every day.
 * Weekly: same weekday, from `lead` weeks before arrival while the date is ≤ 4 weeks after leaving
 * (always 4 doses after departure).
 */
export function schedule(drug, win, lead) {
  const step = drug.freq === 'weekly' ? 7 : 1;
  const first = addDays(win.start, -(drug.freq === 'weekly' ? lead * 7 : lead));
  const stop = dayMs(addDays(win.end, drug.afterDays));
  const dates = [];
  for (let t = dayMs(first); t <= stop; t += step * DAY) dates.push(isoDay(t));
  return { first, last: dates.at(-1), doses: dates.length, dates, step };
}

/** Tablets to buy: per-dose fraction × doses, rounded up to whole tablets. */
export function tabletsToBuy(perDose, doses) {
  if (!(perDose > 0) || !(doses > 0)) return null;
  return Math.ceil(perDose * doses - 1e-9);
}

// ---------------------------------------------------------------- calendar
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const fold = (line) => {
  // RFC 5545: lines over 75 octets are folded (continuation lines start with a space)
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > 73) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
};
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const local = (day, hhmm) => `${day.replace(/-/g, '')}T${hhmm.replace(':', '')}00`;

/**
 * iCalendar text. events: [{ uid, title, desc, first: 'YYYY-MM-DD', time: 'HH:MM', freq: 'DAILY'|'WEEKLY', count }]
 * or all-day: { uid, title, desc, day, endDay } . Times are floating (no time zone): a reminder at 08:00 rings at
 * 08:00 wherever the phone is — what a traveller crossing time zones wants.
 */
export function buildICS(events, now = new Date()) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SafeTravel TW//malaria prophylaxis//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const e of events) {
    L.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp(now)}`);
    if (e.day) {
      L.push(`DTSTART;VALUE=DATE:${e.day.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${(e.endDay || addDays(e.day, 1)).replace(/-/g, '')}`);
    } else {
      L.push(`DTSTART:${local(e.first, e.time)}`, 'DURATION:PT15M', `RRULE:FREQ=${e.freq};COUNT=${e.count}`);
    }
    L.push(`SUMMARY:${esc(e.title)}`, `DESCRIPTION:${esc(e.desc)}`);
    if (!e.day) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title)}`, 'TRIGGER:PT0M', 'END:VALARM');
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return `${L.map(fold).join('\r\n')}\r\n`;
}

/** "Add to Google Calendar" link for a repeating reminder (Google's event template with an RRULE). */
export function googleCalendarUrl(e) {
  const start = local(e.first, e.time);
  const [h, m] = e.time.split(':').map(Number);
  const endMin = h * 60 + m + 15;
  const end = endMin >= 1440 ? local(addDays(e.first, 1), `${String(Math.floor((endMin - 1440) / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`)
    : local(e.first, `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`);
  const q = new URLSearchParams({
    action: 'TEMPLATE', text: e.title, dates: `${start}/${end}`, details: e.desc, recur: `RRULE:FREQ=${e.freq};COUNT=${e.count}`,
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}
