// Self-pay malaria prophylaxis prices published by Taiwan travel medicine clinics, for the cost estimate on
// malaria.html when no price per tablet is typed in. Unofficial: each clinic sets its own price and changes it
// over time; the page shows the range, says it is an estimate and lists the sources below.
//
// Collected 2026-11-27 from the hospitals' public price lists (as indexed by a web search: the lists themselves
// could not be opened from the build environment, so check each figure against its list when updating).
// To update: change the figures and dates, add or drop a hospital, and set CHECKED. The range is computed from
// the lists (min–max), nothing else to change. `date` is the list's own date when it shows one, else ''.

export const CHECKED = '2026-11-27';

const VGHTC = { zh: '臺中榮民總醫院', en: 'Taichung Veterans General Hospital', date: '2026-03-06',
  url: 'https://www.vghtc.gov.tw/UploadFiles/WebFiles/WebPagesFiles/Files/daa3cfe6-11c2-4761-9891-e33f0910af38/%E8%87%BA%E4%B8%AD%E6%A6%AE%E6%B0%91%E7%B8%BD%E9%86%AB%E9%99%A2%E6%97%85%E9%81%8A%E9%86%AB%E5%AD%B8%E9%96%80%E8%A8%BA%E5%83%B9%E7%9B%AE%E8%A1%A8.pdf' };
const MMH = { zh: '馬偕紀念醫院', en: 'MacKay Memorial Hospital', date: '2025-08',
  url: 'https://www.mmh.org.tw/child/upload/doc/sale/%E6%97%85%E9%81%8A%E9%86%AB%E5%AD%B8%E9%96%80%E8%A8%BA%E5%83%B9%E7%9B%AE%E8%A1%A82025.08.pdf' };
const MMH23 = { ...MMH, date: '2023-02',
  url: 'https://www.mmh.org.tw/upload/doc/sale/%E6%97%85%E9%81%8A%E9%86%AB%E5%AD%B8%E9%96%80%E8%A8%BA%E5%83%B9%E7%9B%AE%E8%A1%A82023.02.pdf' };
const STM = { zh: '天主教聖馬爾定醫院', en: 'St. Martin De Porres Hospital', date: '',
  url: 'https://www.stm.org.tw/hmc/travel01.aspx?ids=208' };
const SMH = { zh: '羅東聖母醫院', en: 'Lotung Saint Mary’s Hospital', date: '',
  url: 'https://www.smh.org.tw/?aid=100&pid=133' };
const MIL = { zh: '衛生福利部苗栗醫院', en: 'Miaoli General Hospital, MOHW', date: '',
  url: 'https://www.mil.mohw.gov.tw/Serve/Travel.asp' };
const PCH = { zh: '埔里基督教醫院', en: 'Puli Christian Hospital', date: '',
  url: 'https://www.pch.org.tw/department.php?depid=128' };

/** NT$ per tablet, by drug id (malaria-calc.js DRUGS). */
export const PRICES = {
  atq: [{ ...VGHTC, price: 275 }, { ...MMH, price: 260 }, { ...STM, price: 275 }],
  mef: [{ ...MMH, price: 288 }, { ...SMH, price: 300 }, { ...STM, price: 200 }],
  dox: [{ ...MMH23, price: 3 }, { ...SMH, price: 3 }, { ...STM, price: 5 }, { ...MIL, price: 1.8 }, { ...PCH, price: 3 }],
};

/** Visit fees on the same lists (the travel medicine clinic is self-pay, not covered by National Health Insurance). */
export const VISIT = {
  reg: [{ ...VGHTC, price: 150 }, { ...MMH, price: 180 }],
  exam: [{ ...VGHTC, price: 286 }, { ...MMH, price: 400 }],
};

/** [min, max] of a list of {price}; null when empty. */
export function range(list) {
  const p = (list || []).map((x) => x.price).filter((v) => Number.isFinite(v) && v > 0);
  return p.length ? [Math.min(...p), Math.max(...p)] : null;
}

/** Estimated cost [lo, hi] in NT$ for `tablets` tablets of drug `id`, rounded to whole dollars; null when unknown. */
export function estimate(id, tablets) {
  const r = range(PRICES[id]);
  if (!r || !(tablets > 0)) return null;
  return [Math.round(r[0] * tablets), Math.round(r[1] * tablets)];
}
