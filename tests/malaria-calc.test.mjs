// Malaria prophylaxis logic checked against Taiwan CDC's page 「瘧疾預防用藥」 (last updated 2026-02-05):
// https://www.cdc.gov.tw/Category/ListContent/YipvR33b32K-dsMI2eIrIg?uaid=ZSgu_4NoQ7NTp0zZ-HC8rg
// The expectations below were written from the page, not from the code. No browser: node tests/malaria-calc.test.mjs
import {
  DRUGS, doseFor, assess, schedule, riskWindow, verdict, tabletsToBuy, addDays, daysBetween, dayMs, buildICS,
} from '../web/js/malaria-calc.js';

let failed = 0;
let n = 0;
const eq = (got, want, what) => {
  n += 1;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) { failed += 1; console.log(`[FAIL] ${what}: got ${a}, want ${b}`); }
};
const drug = (id) => DRUGS.find((d) => d.id === id);
const atq = drug('atq');
const dox = drug('dox');
const mef = drug('mef');
const adult = { age: 35, weight: 70, pregnant: 'no' };
const child = (age, weight) => ({ age, weight, pregnant: 'no' });
const st = (d, p, win) => assess(d, { pregnant: 'no', ...p }, win).status;
const why = (d, p, win) => assess(d, { pregnant: 'no', ...p }, win).reasons;

// ---- regimens: frequency, start before arrival, continue after leaving
eq([mef.freq, mef.lead, mef.afterDays], ['weekly', [2, 3], 28], 'mefloquine: weekly, 2–3 weeks before, 4 weeks after');
eq([dox.freq, dox.lead, dox.afterDays], ['daily', [1, 2], 28], 'doxycycline: daily, 1–2 days before, 4 weeks after');
eq([atq.freq, atq.lead, atq.afterDays], ['daily', [1, 2], 7], 'Malarone: daily, 1–2 days before, 7 days after');

// ---- adult doses: one tablet each
eq(doseFor(mef, adult), { tablets: 1, mg: 250, note: null }, 'mefloquine adult 250 mg (1 tablet)');
eq(doseFor(dox, adult), { tablets: 1, mg: 100, note: null }, 'doxycycline adult 100 mg (1 tablet)');
eq(doseFor(atq, adult).tablets, 1, 'Malarone adult 1 tablet');
eq(doseFor(atq, { age: 40 }).tablets, 1, 'Malarone adult, weight not given: 1 tablet');

// ---- mefloquine children: ≤9 kg 5 mg/kg salt · >9–19 ¼ · >19–30 ½ · >30–45 ¾ · >45 1; ≤10 kg pharmacist
for (const [w, tablets] of [[9.1, 0.25], [10, 0.25], [10.1, 0.25], [19, 0.25], [19.1, 0.5], [30, 0.5], [30.1, 0.75], [45, 0.75], [45.1, 1], [60, 1]]) {
  eq(doseFor(mef, child(10, w)).tablets, tablets, `mefloquine child ${w} kg`);
}
eq(doseFor(mef, child(1, 9)), { tablets: null, mg: 45, note: 'dose_mef_infant' }, 'mefloquine 9 kg: 5 mg/kg = 45 mg, pharmacist, no tablet count');
eq(doseFor(mef, child(1, 6.4)).mg, 32, 'mefloquine 6.4 kg: 32 mg');
eq(doseFor(mef, child(1, 9.5)).note, 'dose_mef_10kg', 'mefloquine 9.5 kg: ¼ tablet with the pharmacist note');
eq(doseFor(mef, child(1, 10)).note, 'dose_mef_10kg', 'mefloquine 10 kg: pharmacist note (10 kg 以下)');
eq(doseFor(mef, child(2, 10.5)).note, null, 'mefloquine 10.5 kg: no pharmacist note');
eq(doseFor(mef, child(10, 0)).note, 'dose_need_weight', 'child without weight: asks for it');
eq(st(mef, child(0.5, 4)), 'ok', 'mefloquine: any age and weight');

// ---- doxycycline children: from 8 years, 2.2 mg/kg, never above the adult dose
eq(doseFor(dox, child(10, 25)), { tablets: null, mg: 55, note: 'dose_dox_child' }, 'doxycycline 25 kg: 55 mg');
eq(doseFor(dox, child(12, 45)).mg, 99, 'doxycycline 45 kg: 99 mg');
eq(doseFor(dox, child(15, 46)), { tablets: 1, mg: 100, note: null }, 'doxycycline 46 kg: capped at 100 mg');
eq(st(dox, child(7, 25)), 'no', 'doxycycline under 8: contraindicated');
eq(st(dox, child(8, 25)), 'ok', 'doxycycline at 8: allowed');

// ---- Malarone weight limits: 40 kg or less → weight-adjusted (no Taiwanese paediatric tablet); 5 kg or less → not recommended
eq(doseFor(atq, child(10, 30)), { tablets: null, mg: null, note: 'dose_atq_child' }, 'Malarone 30 kg child: no tablet count');
eq(doseFor(atq, { age: 30, weight: 40 }).note, 'dose_atq_child', 'Malarone adult of exactly 40 kg: weight-adjusted');
eq(doseFor(atq, { age: 30, weight: 40.5 }).tablets, 1, 'Malarone adult 40.5 kg: 1 tablet');
eq(doseFor(atq, child(15, 55)).tablets, 1, 'Malarone child above 40 kg: adult tablet');
eq([st(atq, child(1, 5)), why(atq, child(1, 5))], ['no', ['r_atq_5kg']], 'Malarone 5 kg: not recommended');
eq([st(atq, child(1, 5.1)), why(atq, child(1, 5.1))], ['caution', ['r_atq_40kg']], 'Malarone 5.1 kg: doctor adjusts');
eq(st(atq, { age: 30, weight: 40 }), 'caution', 'Malarone 40 kg adult: doctor adjusts');
eq(st(atq, { age: 30, weight: 41 }), 'ok', 'Malarone 41 kg adult: fine');

// ---- contraindications (禁忌症) → not suitable
eq(st(atq, { ...adult, pregnant: 'yes' }), 'no', 'Malarone: pregnancy');
eq(st(dox, { ...adult, pregnant: 'yes' }), 'no', 'doxycycline: pregnancy');
eq(st(mef, { ...adult, pregnant: 'yes' }), 'ok', 'mefloquine: usable in every trimester');
eq(st(atq, { ...adult, breastfeeding: true, infantUnder5: true }), 'no', 'Malarone: breastfeeding an infant under 5 kg');
eq(st(atq, { ...adult, breastfeeding: true, infantUnder5: false }), 'ok', 'Malarone: breastfeeding, infant 5 kg or more');
eq(st(mef, { ...adult, breastfeeding: true }), 'ok', 'mefloquine: usable while breastfeeding');
eq(st(atq, { ...adult, renal: true }), 'no', 'Malarone: severe renal impairment');
eq(st(mef, { ...adult, psych: true }), 'no', 'mefloquine: psychiatric history');
eq(st(mef, { ...adult, seizure: true }), 'no', 'mefloquine: seizures / epilepsy');
for (const [d, key] of [[atq, 'allergyAtq'], [dox, 'allergyDox'], [mef, 'allergyMef']]) eq(st(d, { ...adult, [key]: true }), 'no', `${d.id}: allergy`);
eq([st(atq, { ...adult, allergyDox: true }), st(mef, { ...adult, allergyAtq: true })], ['ok', 'ok'], 'an allergy rules out only its own drug');

// ---- CDC advises against it (不建議使用 / 建議選用其他預防性藥物) → not suitable, with the wording as the reason
eq([st(mef, { ...adult, arrhythmia: true }), why(mef, { ...adult, arrhythmia: true })], ['no', ['r_mef_arrhythmia']], 'mefloquine: history of arrhythmia');
eq([st(dox, { ...adult, yeast: true }), why(dox, { ...adult, yeast: true })], ['no', ['r_dox_yeast']], 'doxycycline: fungal infections after antibiotics');

// ---- cautions → a doctor decides
eq(st(dox, { ...adult, breastfeeding: true }), 'caution', 'doxycycline: breastfeeding');
eq(st(dox, { ...adult, liver: true }), 'caution', 'doxycycline: liver insufficiency');
eq(st(mef, { ...adult, bupropion: true }), 'caution', 'mefloquine: bupropion');
eq(st(mef, { ...adult, precision: true }), 'caution', 'mefloquine: driving, machines, diving');
eq([st(mef, { ...adult, hiv: true }), st(atq, { ...adult, hiv: true }), st(dox, { ...adult, hiv: true })], ['caution', 'caution', 'ok'], 'HIV medicines: mefloquine and Malarone interact, doxycycline has no known interaction');
eq(DRUGS.map((d) => st(d, { ...adult, pregnant: 'planning' })), ['caution', 'caution', 'caution'], 'planning a pregnancy: every drug goes to the doctor');
eq([st(dox, adult), why(dox, adult)], ['ok', ['r_dox_sun']], 'doxycycline: sun-sensitivity is advice, not a caution status');
eq(assess(dox, { ...adult, acneDox: true }), { status: 'covered', reasons: ['r_dox_acne'] }, 'already on doxycycline for acne: covered');
eq(st(mef, adult, { mefResistant: true }), 'no', 'mefloquine: resistant area on the trip');
eq([st(atq, adult, { mefResistant: true }), st(dox, adult, { mefResistant: true })], ['ok', 'ok'], 'resistance to mefloquine does not touch the other two');

// ---- schedules. Risk area 10–20 Dec (11 days)
const win = { start: '2026-12-10', end: '2026-12-20' };
let s = schedule(atq, win, 1);
eq([s.first, s.last, s.doses], ['2026-12-09', '2026-12-27', 19], 'Malarone, 1 day before: 9 Dec – 27 Dec, 1 + 11 + 7 doses');
s = schedule(atq, win, 2);
eq([s.first, s.doses], ['2026-12-08', 20], 'Malarone, 2 days before');
s = schedule(dox, win, 1);
eq([s.first, s.last, s.doses], ['2026-12-09', '2027-01-17', 40], 'doxycycline, 1 day before: 1 + 11 + 28 doses');
s = schedule(mef, win, 2);
eq([s.first, s.dates], ['2026-11-26', ['2026-11-26', '2026-12-03', '2026-12-10', '2026-12-17', '2026-12-24', '2026-12-31', '2027-01-07', '2027-01-14']], 'mefloquine, 2 weeks before: weekly, same weekday');
eq(s.dates.filter((d) => d > win.end).length, 4, 'mefloquine: 4 doses after leaving');
s = schedule(mef, win, 3);
eq([s.first, s.doses], ['2026-11-19', 9], 'mefloquine, 3 weeks before');
// every stay length: daily drugs cover each day through the last after-day; mefloquine always 4 weekly doses after leaving
for (let len = 1; len <= 40; len += 1) {
  const w = { start: '2026-03-01', end: addDays('2026-03-01', len - 1) };
  for (const lead of [1, 2]) {
    eq(schedule(atq, w, lead).doses, lead + len + 7, `Malarone ${len}-day stay, ${lead} day(s) before`);
    eq(schedule(dox, w, lead).doses, lead + len + 28, `doxycycline ${len}-day stay, ${lead} day(s) before`);
  }
  for (const lead of [2, 3]) {
    const m = schedule(mef, w, lead);
    eq(m.dates.filter((d) => d > w.end).length, 4, `mefloquine ${len}-day stay: doses after leaving`);
    eq(m.dates.filter((d) => d < w.start).length, lead, `mefloquine ${len}-day stay: doses before arriving`);
    eq(m.dates.every((d, i) => i === 0 || daysBetween(m.dates[i - 1], d) === 7), true, `mefloquine ${len}-day stay: 7 days apart`);
    eq(daysBetween(w.end, m.last) <= 28 && daysBetween(w.end, m.last) > 21, true, `mefloquine ${len}-day stay: last dose in the 4th week after leaving`);
  }
}
// across a leap day and a year end
eq(schedule(atq, { start: '2028-02-27', end: '2028-03-01' }, 1).dates.includes('2028-02-29'), true, 'leap day is a dose day');
eq(schedule(dox, { start: '2026-12-28', end: '2027-01-02' }, 1).last, '2027-01-30', 'year end');
eq(Number.isNaN(dayMs('2026-02-30')), true, 'impossible date rejected');

// ---- tablets to buy: fractions round up to whole tablets
eq([tabletsToBuy(1, 19), tabletsToBuy(0.25, 8), tabletsToBuy(0.25, 9), tabletsToBuy(0.5, 9), tabletsToBuy(0.75, 8), tabletsToBuy(0.75, 9)], [19, 2, 3, 5, 6, 7], 'tablets to buy');
eq(tabletsToBuy(null, 9), null, 'no count without a tablet dose');

// ---- which legs count, and the overall answer
const leg = (risk, visit, arrive, depart, mefRes = false) => ({ risk, visit, arrive: `${arrive}T10:00`, depart: `${depart}T18:00`, mef: mefRes });
eq(verdict([leg('drug', 'yes', '2026-12-10', '2026-12-20')]), 'need', 'risk area, going: needs assessment for medicine');
eq(verdict([leg('drug', 'unsure', '2026-12-10', '2026-12-20')]), 'need', 'not sure about the risk areas: treated as going');
eq(verdict([leg('drug', 'no', '2026-12-10', '2026-12-20')]), 'avoid-areas', 'staying out of the risk areas: no medicine, keep away and avoid bites');
eq(verdict([leg('bites', 'yes', '2026-12-10', '2026-12-20')]), 'bites', 'mosquito protection only');
eq(verdict([leg('none', 'yes', '2026-12-10', '2026-12-20')]), 'none', 'no risk');
eq(verdict([leg('unknown', 'yes', '2026-12-10', '2026-12-20')]), 'need', 'no CDC text for the country: treated as risk');
eq(verdict([leg('', 'yes', '2026-12-10', '2026-12-20')]), 'incomplete', 'country not chosen');
eq(verdict([{ risk: 'drug', visit: 'yes', arrive: '', depart: '' }]), 'incomplete', 'dates missing');
const two = riskWindow([leg('none', 'yes', '2026-12-01', '2026-12-05'), leg('drug', 'yes', '2026-12-05', '2026-12-12', true), leg('drug', 'yes', '2026-12-12', '2026-12-18'), leg('bites', 'yes', '2026-12-18', '2026-12-22')]);
eq([two.start, two.end, two.days, two.mefResistant], ['2026-12-05', '2026-12-18', 14, true], 'two risk stops: one window, resistance on either stop counts');

// ---- calendar file: repeat count equals the number of doses
const ics = buildICS([{ uid: 'x@test', title: 'Malarone', desc: 'd', first: '2026-12-09', time: '08:00', freq: 'DAILY', count: 19 }], new Date('2026-11-01T00:00:00Z'));
eq(/DTSTART:20261209T080000\r\n/.test(ics) && /RRULE:FREQ=DAILY;COUNT=19\r\n/.test(ics) && /BEGIN:VALARM/.test(ics), true, 'calendar: start, repeat count, alarm');

console.log(`\nmalaria logic: ${n} checks, ${n - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
