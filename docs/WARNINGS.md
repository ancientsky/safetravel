# Travel warnings (外交部 國外旅遊警示 · 陸委會 陸港澳旅遊警示)

The map and the public trip page show two **separate official ratings side by side**, never merged into one score:

| | Taiwan CDC 旅遊疫情建議 | MOFA (BOCA) 國外旅遊警示 / MAC 陸港澳旅遊警示 |
|---|---|---|
| Measures | communicable disease only | overall safety: crime, conflict, disasters, political/legal risk, health |
| Scale | 3 levels (注意 / 警示 / 警告) | 4 colours: 1 灰色提醒 · 2 黃色注意 · 3 橙色避免前往 · 4 紅色儘速離境 (MAC: 灰 · 黃 · 橙 · 紅) |
| Scope | country + sub-national rows | country + sub-national areas; mainland China / Hong Kong / Macau are rated by MAC |

MOFA states its warnings are reference information without binding force on refunds, tickets or insurance;
the UI repeats that note.

## Sources

- **BOCA RSS** `https://www.boca.gov.tw/sp-trwa-rss-1.xml` (data.gov.tw dataset 116026): one `<item>` per
  country or area: `title` = `第N級：顏色… - 中文名 - English` (regional items often carry only the area name),
  `link` = content page (`sp-trwa-content-<id>-<hash>-1.html`), `description` = full warning text (HTML),
  `pubDate` = last update. ≈ 257 items, ≈ 560 KB.
- **BOCA list page** `https://www.boca.gov.tw/sp-trwa-list-1.html`: table *國家/地區 · 區域 · 最新警示分級* with a
  link per row. It gives the **parent country of regional items**; items are joined with the RSS by content id.
- Both are fetched by `update-data.yml` (twice a day) and saved to `data/raw/boca/`; reachable from GitHub runners.
- **MAC**: the MAC site sits behind a Cloudflare JavaScript challenge, so mainland China / HK / Macau come from the
  hand-maintained `data/manual/mac_warnings.json` (level, since, summary, `confirmed` date, source URL
  `https://www.mac.gov.tw/News.aspx?n=E0243AD02975213D&sms=EF1DC35EB9749B36`). The UI shows the confirmation date.

## Country mapping

Names → ISO 3166-1 alpha-2, first match wins: `data/manual/boca_names.json` overrides → names in
`web/data/countries.json` (zh/en) → CDC CSV names (`alerts_raw.areaDesc`/`areaDesc_EN` with their ISO) →
`data/manual/country_names.json`. Unmatched items are exported under `unmapped` and logged (never dropped silently).

## Change history (SQLite)

`mofa_levels(key PRIMARY KEY, iso, area_zh, level, url, first_seen, last_seen)` holds the latest level per key
(`ISO|area` — area empty for the whole country). Each run compares the new snapshot: a different level appends
`mofa_changes(date, iso, area_zh, from_level, to_level)`. The very first run only records a baseline (no changes).
Keys that disappear are recorded as a change to `null` (warning withdrawn).

## `web/data/warnings.json`

```json
{
  "generated_at": "2026-10-18T21:17:00+08:00",
  "sources": {
    "mofa": { "url": "https://www.boca.gov.tw/sp-trwa-list-1.html", "rss": "https://www.boca.gov.tw/sp-trwa-rss-1.xml",
              "fetched_at": "…", "items": 257, "ok": true },
    "mac":  { "url": "https://www.mac.gov.tw/News.aspx?n=E0243AD02975213D&sms=EF1DC35EB9749B36", "confirmed": "2026-02-02", "manual": true }
  },
  "levels": {
    "0": { "zh": "未發布旅遊警示分級", "en": "No warning issued", "short_zh": "未發布", "short_en": "None" },
    "1": { "zh": "第一級：灰色提醒", "en": "Level 1: Grey – be aware", "short_zh": "灰色提醒", "short_en": "Grey" },
    "2": { "zh": "第二級：黃色注意", "en": "Level 2: Yellow – exercise caution", "short_zh": "黃色注意", "short_en": "Yellow" },
    "3": { "zh": "第三級：橙色避免前往", "en": "Level 3: Orange – avoid non-essential travel", "short_zh": "橙色避免前往", "short_en": "Orange" },
    "4": { "zh": "第四級：紅色儘速離境", "en": "Level 4: Red – leave as soon as possible", "short_zh": "紅色儘速離境", "short_en": "Red" }
  },
  "countries": {
    "KH": {
      "source": "mofa",
      "name_zh": "柬埔寨", "name_en": "Cambodia",
      "level": 3, "max_level": 4,
      "date": "2026-08-20",
      "id": "3067", "url": "https://www.boca.gov.tw/sp-trwa-content-3067-…-1.html",
      "summary_zh": "一、……（first paragraph, ≤ 220 characters）",
      "areas": [
        { "area_zh": "柏威夏省、奧多棉芷省…", "area_en": "", "level": 4, "date": "2026-08-20",
          "id": "3070", "url": "https://www.boca.gov.tw/sp-trwa-content-3070-…-1.html", "summary_zh": "…" }
      ]
    },
    "CN": { "source": "mac", "name_zh": "中國大陸", "name_en": "Mainland China", "level": 3, "max_level": 3,
            "date": "2024-06-27", "confirmed": "2026-02-02", "url": "https://www.mac.gov.tw/…",
            "summary_zh": "…", "summary_en": "…", "areas": [] }
  },
  "unmapped": [ { "title": "…", "level": 2, "url": "…" } ],
  "changes": {
    "mofa": [ { "date": "2026-10-11", "iso": "SA", "area_zh": "", "from": 2, "to": 3 } ],
    "cdc":  [ { "date": "2026-10-08", "iso": "CD", "disease": "伊波拉病毒感染", "area_zh": "", "from": 2, "to": 3 } ]
  }
}
```

Rules:
- `level` = the whole-country item's level (0 = "未發布旅遊警示分級"); when a country has only regional items,
  `level` is `null`. `max_level` = max over the country item and its areas (`null` only if no items at all).
- `date` = newest `pubDate` (Asia/Taipei, `YYYY-MM-DD`) among the country's items; `summary_zh` = first numbered
  paragraph of the description, tags stripped, NFKC, ≤ 220 chars (ellipsis when cut).
- `areas` sorted by level desc, then `area_zh`. `area_en` from the title when present, else `""`.
- MAC entries (`CN`, `HK`, `MO`) come only from the manual file; any BOCA item for those codes is ignored.
- `changes.mofa`: level changes detected by our history within the last 60 days (newest first).
  `changes.cdc`: CDC advisory changes within the last 60 days from `alerts_raw` (new advisory, level change, or
  lifted → `to: 0`), excluding global advisories, newest first.
- `web/data/warnings-text.json`: `{ "<id>": "full plain text" }` for every BOCA item — lazy-loaded when a reader
  expands a warning. English UI shows the Chinese original with a note (BOCA publishes these in Chinese only).

## On the map (`index.html`)

- A **layer switch** in the toolbar (疫情建議 · 疾管署 / 旅遊警示 · 外交部) re-colours the map, the level chips, the legend
  and the search badges. The choice is stored in `localStorage` (`safetravel.layer`); `?layer=mofa` (or `cdc`) deep-links it.
  `warnings.json` is not critical: the CDC map renders without it and the switch stays disabled if it fails to load.
- MOFA layer colours: `wl-1` grey · `wl-2` yellow · `wl-3` orange · `wl-4` red (CSS `--wl1..4`, both themes); the colour is
  the **whole-country** level. A higher regional level (`max_level > level`) adds a dashed outline in that level's colour
  (legend row 部分地區較高). The breathing danger outline follows the top level of the active layer (CDC L3 / MOFA red).
- Tooltip and panel head always show **both** ratings side by side (active layer first), never a merged score.
- The panel gets a travel-warning section (外交部旅遊警示 or 陸委會旅遊警示): level, update date, summary, every regional area
  with its own level, a 「展開全文」 toggle that lazy-loads `warnings-text.json` once, the BOCA/MAC link (only `https`
  `www.boca.gov.tw` / `www.mac.gov.tw` become links) and the reference-only note. MAC entries show the hand-check date.
  In the MOFA layer this section comes first.
