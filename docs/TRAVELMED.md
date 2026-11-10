# Travel medicine (疾管署國際旅遊處方箋、旅遊醫學門診)

What `trip.html` shows in each destination card ("出國前健康準備") and in the "旅遊醫學門診" section, where it comes from
and how it is refreshed. Data contract: `docs/DATA_CONTRACT.md` (`travelmed.json`, `travelmed/<ISO>.json`).

## Sources

| What | Where | Refresh | Reachable from GitHub runners |
|---|---|---|---|
| Travel medicine contract hospitals (33) | `https://od.cdc.gov.tw/quarantine/TMClinicsList.csv` | monthly | **no** (connect timeout) |
| Their sessions (Mon–Sun × 早/午/夜) | `https://od.cdc.gov.tw/quarantine/ClinicsTime.csv` | monthly | **no** |
| Travel prescription skeleton (246 places) | `https://od.cdc.gov.tw/quarantine/TMPrescription.csv` | monthly | **no** |
| Travel prescription full text per country | `https://www.cdc.gov.tw/InternationalTravel/Print?cid=…` | CDC edits | yes |

- **The three CSVs** (UTF-8 with BOM) are uploaded by hand to `data/raw/travelmed/` (GitHub → that folder → Add file →
  Upload files, file names unchanged) — `od.cdc.gov.tw`, like `data.gov.tw`, does not answer GitHub-hosted runners.
  `pipeline/travelmed.py fetch()` still tries every run (one connect attempt; a failure skips the other two files) and
  keeps the uploaded copies. A file is replaced only when the new download is UTF-8/Big5 text whose header holds the
  expected columns and that has enough rows.
- **The web pages** carry what the CSV only names: what each vaccine is for and the entry rules (yellow fever
  certificate), malaria risk areas and drug resistance, the detailed prevention advice with sub-points, care during the
  trip with the Taiwan mission's emergency number, after-return advice, and notes for six kinds of traveller.
  `pipeline/travelmed_pages.py crawl()` runs in every data update:
  - the country index (`cid` → name) comes from the page's own form (`AreaList` options → `POST /Internationaltravel/CounterList`),
    refreshed weekly → `data/raw/travelmed/pages/index.json`;
  - each country's print view is requested with **all six traveller groups ticked**
    (`specificGroupIds=1,2,4,5,9,6`), so every group note is in the file and tagged;
  - at most 15 pages and 180 s per run, 1.5 s between requests, oldest first, each page about every 20 days;
    the site answers in ~10 s per page, so a full pass takes a few days of runs; a connection failure stops the run;
  - only the five prescription cards are kept (`旅遊前的準備`, `預防接種規定及建議`, `當地其他相關疾病`,
    `旅途中的健康照護`, `返國後注意事項`), without scripts, styles or attributes, in `pages/<cid>.html`. Live alerts
    (`即時疫情`) and imported-case counts are dropped: the site already has them from the alert feed, and leaving them
    out means a file changes only when CDC edits the text. `pages/state.json` records when each page was checked.

## Parsing (`travelmed_pages.parse`)

The CMS rich text is flattened into lines `{t, d?, h?, k?, g?}`:
- `d` list depth (nested `<ul>`), `h` a short all-bold line (sub-heading such as 預防蚊蟲叮咬, 瘧疾警示),
  `k` a short label before `：` (重要流行疾病, 腹瀉, 外館急難救助專線, 入境預防接種規定);
- `g` the traveller group: a bold `與嬰幼兒同行 / 懷孕婦女 / 慢性病患者 / 免疫不全症患者 / 長期差旅及居留(6個月以上) /
  海外服務志工/救援工作者` opens a group block that lasts until the next group heading or the end of its container;
  a paragraph starting `入境預防接種規定` / `當地預防接種建議` ends it (yellow fever repeats the group notes under both,
  the repeats are dropped);
- the vaccine table becomes `vaccines: [{name, lines}]`; the missions' emergency numbers are lifted out as `hotline: [{where, tel}]` (one per city, e.g. 河內 / 胡志明市);
- text is NFKC-normalised, then `，；：` after a CJK character are restored to full width for display (`common.zh_punct`).

## Export (`travelmed.build`, part of `pipeline export`)

- Places → ISO alpha-2: `countries.json` names (zh, then en), `data/manual/territories.json`, then the `places` table in
  `data/manual/travelmed_en.json`. CDC's numeric ISO column is not used (Madeira carries Malaysia's 458; seven places
  have none). Parts of a country with their own prescription (Azores, Madeira, Canary Islands, Easter Island, Tahiti,
  Saba, Sint Eustatius) become `subs` of the parent; the Sovereign Military Order of Malta is skipped. Pages whose name
  is not a place (全球(…國家除外), 索馬利蘭) are logged and skipped.
- `國際旅遊疫情建議等級` rows are not exported: they duplicate `alerts.json`.
- English: `data/manual/travelmed_en.json` (advice sentences, vaccines and the diseases each one prevents, disease
  qualifiers, cities, departments, hospital names). Disease base names also come from `data/manual/diseases.json` and
  `alerts.json`. Anything missing is exported with `en = zh` and logged. The web-page text stays Chinese; the English UI
  labels it "Chinese original".
- Clinics: sessions are joined by medical institution code, else by hospital name (the two CSVs disagree on Penghu's
  code); sorted north → south by city. `updated` changes only when the three CSVs change (SHA-1).
- Nothing is written when the CSVs are missing or yield < 150 countries / < 10 clinics (the previous files stay).

## Front end

- `web/js/trip-med.js` — card section, after the epidemic summary. Loads `travelmed.json` (once) and
  `travelmed/<ISO>.json` (only when `countries[iso].page` says it exists). Blocks: timing note (2–4 weeks, from CDC's
  vaccination intro) with a button to the clinic finder; traveller-group toggles (stored in `localStorage`
  `safetravel.trip.groups`; CSS classes `show-<group>` reveal the tagged lines, counts per group on each toggle);
  vaccines (one `<details>` per item, CDC's text only — no computed "disease present" tag); local diseases by route (insect/tick, food/water, contact, other, fresh water) with the short advice;
  emergency numbers as `tel:` links; CDC's full prevention, during-trip, after-return and checklist text. Areas CDC lists
  separately (Portugal → Azores, Madeira) switch with buttons. Printing opens every section.
- `web/js/trip-clinics.js` — `#clinics` section: city select, "現在有門診" (sessions taken as 08:00–12:00, 13:30–17:30,
  18:00–21:30 Taipei time — CDC publishes only 早/午/夜), "可接種 M 痘疫苗", "離我最近" (Geolocation API; the position
  is used in the browser only), a 7 × 3 week grid per clinic, next-session label, call / website / map links (map =
  coordinate search on Google Maps). Wide screens (≥ 1000 px) add a locator map with Kinmen and Matsu insets.

## Malaria prophylaxis calculator (`malaria.html`, draft)

A page of its own, `noindex`, still a draft awaiting review by physicians and labelled **unofficial** on the page itself.
It is reached from the destination card on `trip.html`: `trip-med.js` `malariaBlock` adds an "unofficial" timing table
(the three drugs' frequency, start before arrival and duration after leaving, from `malaria-calc.js` `DRUGS`; mefloquine
flagged where CDC's row mentions its resistance) and a link `malaria.html?c=<ISO>` under the vaccine list — only where
CDC's malaria row asks a doctor to assess preventive medicine (the pipeline's `drug` class) or is listed without page
text. Both carry the notice that they are not a Taiwan CDC service and that a doctor prescribes.
- **Data**: `web/data/malaria.json` (built with `travelmed.json`): per destination, CDC's `瘧疾預防用藥` row from the
  travel prescription page — risk areas, resistance, traveller-group notes — and a class taken from CDC's own wording:
  `drug` when it asks a doctor to assess preventive medicine (「請醫師評估是否需口服預防藥物」), `none` when it says
  there is no risk or malaria was eradicated, else `bites` (mosquito protection only); `unknown` when the CSV lists the
  row but the page text is missing. `mef_resistant` when the row mentions mefloquine resistance (Thailand, Myanmar,
  Cambodia, Laos, Vietnam — the same five areas as CDC's drug table).
- **Rules**: `web/js/malaria-calc.js`, from CDC's 「瘧疾預防用藥」 page (國內現用藥品簡介, updated 2026-02-05): the
  three drugs in use in Taiwan, their schedules (Malarone and doxycycline daily from 1–2 days before, mefloquine weekly
  from 2–3 weeks before; 7 days / 4 weeks / 4 weeks after leaving), adult and child doses, contraindications and
  cautions. Where CDC leaves the dose to the doctor (Malarone at 40 kg or less — no paediatric tablet in Taiwan;
  doxycycline 2.2 mg/kg for children; mefloquine ≤ 9 kg) no tablet count is given. Two cautions come from CDC's travel
  prescription instead of that page: interactions with HIV medicines and planning a pregnancy.
- **Reading of the page** (checked against it again on 2026-11-10): limits written 「以下」 include the number (Malarone:
  40 kg or less is weight-adjusted, 5 kg or less not recommended; mefloquine: at 10 kg or less a pharmacist prepares the
  dose, so 9–10 kg shows ¼ tablet with that note). 禁忌症 → "not suitable". The two cautions worded as advice against
  use — mefloquine with a history of arrhythmia (「不建議使用」) and doxycycline for women prone to fungal infections after
  antibiotics (「建議選用其他預防性藥物」) — are also shown as "not suitable", with CDC's wording as the reason; other
  cautions → "needs the doctor's attention". The page gives adult and child doses without an age; the tool treats 18
  and over as adult.
- **Test**: `node tests/malaria-calc.test.mjs` (no browser, 563 checks written from the page: every dose band and its
  edges, each contraindication and caution, schedules for stays of 1–40 days, tablets to buy). The Pages deploy runs it
  and stops when it fails.
- **Trip**: several stops; a stop counts when its class is `drug`/`unknown` and the traveller answers that the trip
  goes (or may go) to CDC's risk areas. The risk window runs from the first such arrival to the last departure.
  Weekly doses fall on the first dose's weekday and always include 4 doses after leaving.
- **Output**: per drug: can be considered / needs the doctor's attention / not suitable (with CDC's reasons), first
  and last dose, number of doses, tablets to buy (fractions rounded up), optional price → cost, a timeline, a
  repeating reminder for Google Calendar (event template with an RRULE) and an `.ics` file (floating local time, an
  alarm on each dose, plus a 90-day "malaria watch" after return). Nothing typed is stored or sent.
- `WHO_NOTES` (in `malaria-calc.js`): the CDC malaria page's own notes (註 c and the footnote of its WHO map) for
  countries whose travel prescription may lag behind — Malaysia, Saudi Arabia, Bhutan, Belize, Azerbaijan, Timor-Leste,
  Suriname. Shown beside the country; the class still follows the prescription text, the doctor decides.
- **Risk map** (`web/js/malaria-map.js`, top of the page): one SVG world map, two layers — Taiwan CDC's advice per
  destination (`malaria.json` `countries[].risk`) and WHO's malaria status in 2024 (`malaria.json` `who`). Hover shows
  both; clicking a country with a CDC entry fills the first empty stop or adds one; stops are outlined on the map.
  The source line credits WHO (World Malaria Report 2025), links the original image on cdc.gov.tw and CDC's page, and
  says the colours are a country-by-country reading of that image.
- **WHO layer data**: `data/manual/who_malaria_2024.json`, hand-maintained. It was digitised once from the map
  image CDC attaches to its 瘧疾預防用藥 page:
  - world.json was registered onto the image (Kavrayskiy VII plus a quadratic correction fitted to 15 coastline
    landmarks, ~3.5 px mean error);
  - each country took the majority legend colour inside its outline;
  - every doubtful country (tight borders, small or island states) was checked by eye on enlarged crops.
  Taiwan, Hong Kong and Macao are drawn as China there and are left unclassified (`exclude`). The result was then
  cross-checked against WHO's list of countries certified malaria-free (`source.certified_list`): `certified` is
  exactly the 21 countries certified in 2000 or later (Cabo Verde 2024 and Maldives 2015 included). Bahrain, Kuwait and
  Qatar are on WHO's list from outside that period and count as no malaria. Syria has the certified colour on the
  image but is not certified; WHO gives it malaria-free status (no indigenous cases since 2005, `refs.SY`), so it sits
  with the zero-indigenous-cases group. When CDC replaces the image or WHO certifies another country, update the lists.
- Tests: `tests/malaria-smoke.mjs` (regimens, contraindications, resistance, calendar output, phone width).
