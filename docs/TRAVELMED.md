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
  vaccines (one `<details>` per item; "當地有此疾病" when a disease it prevents is in this place's list or in CDC's
  current alerts); local diseases by route (insect/tick, food/water, contact, other, fresh water) with the short advice;
  emergency numbers as `tel:` links; CDC's full prevention, during-trip, after-return and checklist text. Areas CDC lists
  separately (Portugal → Azores, Madeira) switch with buttons. Printing opens every section.
- `web/js/trip-clinics.js` — `#clinics` section: city select, "現在有門診" (sessions taken as 08:00–12:00, 13:30–17:30,
  18:00–21:30 Taipei time — CDC publishes only 早/午/夜), "可接種 M 痘疫苗", "離我最近" (Geolocation API; the position
  is used in the browser only), a 7 × 3 week grid per clinic, next-session label, call / website / map links (map =
  coordinate search on Google Maps). Wide screens (≥ 1000 px) add a locator map with Kinmen and Matsu insets.
