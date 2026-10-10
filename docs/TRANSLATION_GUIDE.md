# Translation & overview guide (scheduled Claude routine)

This is the procedure the daily Claude routine follows to translate new Taiwan CDC epidemic digests and refresh
country overviews **without** the Gemini API. GitHub Actions still fetches the data twice a day
(`update-data.yml` with `--skip-gemini`); the routine only does the language work.

## Procedure

```bash
cd /home/user/safetravel || git clone https://github.com/ancientsky/safetravel /home/user/safetravel
cd /home/user/safetravel && git checkout main && git pull --rebase origin main
python -m pip install -q -r pipeline/requirements.txt   # same interpreter that runs the pipeline; bare `pip` may differ
rm -rf /tmp/pend && python -m pipeline pending --out /tmp/pend      # prints JSON counts
```

If `translations`, `overviews` and `diseases` are all 0: stop, nothing to do.

1. **Translations** — for each `/tmp/pend/translations/in/chunk_NNN.json`, produce `/tmp/pend/translations/out/chunk_NNN.json`
   (JSON list, one object per input item, same order) with keys
   `hash` (copied), `headline_en`, `description_en`, `summary_zh`, `summary_en`.
   Delegate to Haiku sub-agents, at most 6 chunks per agent, following the **translation rules** below.
2. **Overviews** — for each `/tmp/pend/overviews/in/countries_NN.json`, write the country overviews and merge them into
   `/tmp/pend/overviews/out/all.json` as `{ISO2: {"zh": ..., "en": ...}}` following the **overview rules** below.
   Delegate to Sonnet sub-agents, one per input file.
3. **Disease names** — if `/tmp/pend/diseases/in/names.json` exists (a JSON list of Chinese disease names that have no
   English name yet), write `/tmp/pend/diseases/out/names.json` as `{zh: en}` covering every name, using the standard
   WHO / US CDC English name in a short tag form (e.g. `沙門氏菌感染症` → `Salmonellosis`, `急性病毒性A型肝炎` →
   `Acute hepatitis A`, `流感併發重症` → `Severe complicated influenza`). Do this yourself (the list is short).
   No Chinese characters in the English values.
4. **Validate** every output: parses as JSON, same count and hash order as the input, no empty field,
   `summary_zh` ≤ 40 chars, `summary_en` ≤ 30 words, no Kangxi-radical characters (U+2F00–U+2FD5, U+2E80–U+2EF3).
5. **Import, export, verify**
   ```bash
   python pipeline/import_translations.py translations /tmp/pend/translations/out --model claude-haiku-routine
   python pipeline/import_translations.py overviews /tmp/pend/overviews/out/all.json --model claude-sonnet-routine
   [ -f /tmp/pend/diseases/out/names.json ] && python pipeline/import_translations.py diseases /tmp/pend/diseases/out/names.json --model claude-routine
   python -m pipeline export && python -m pipeline validate
   ```
6. **Commit and push** (`data/safetravel.db`, `web/data/`):
   ```bash
   git -c user.name=ancientsky -c user.email=7279958+ancientsky@users.noreply.github.com \
       commit -am "data: translate N digests, refresh M overviews, name K diseases" && git push origin main
   ```
   On a non-fast-forward rejection (`data/safetravel.db` is binary and also written by the Actions workflow, so a rebase
   never merges it meaningfully): `git pull --rebase -X theirs origin main`, then **redo the whole import**: re-run
   `import_translations.py` for every kind (translations, overviews, diseases), `python -m pipeline export`,
   `python -m pipeline validate`, commit the result, and only then push again. Never push an export that was not
   validated after the rebase. Up to 3 attempts.
   Pushing `web/**` triggers the Pages deploy automatically; that workflow runs `python -m pipeline validate` first and
   refuses to publish invalid `web/data`.

## Translation rules

- Faithful, complete English translation in a public-health register. Keep every number, date, place name,
  percentage and agency name. Never add or omit facts. Empty description → translate the headline instead.
- Source text contains Kangxi-radical look-alikes (⾏ ⼈ ⿇ ⽉ ⾮ ⺠): read them as the normal characters; write only
  normal CJK in `summary_zh`.
- `headline_en` pattern: `美國-流行性腮腺炎` → `United States – Mumps`; `宏都拉斯/哈薩克-百日咳` → `Honduras / Kazakhstan – Pertussis`.
- `summary_zh`: one sentence, Traditional Chinese (Taiwan usage), ≤ 40 characters, the key fact (who/where, cases/deaths,
  trend or response). `summary_en`: one sentence, ≤ 30 words, same content.
- Standard WHO disease names (登革熱 Dengue, 屈公病 Chikungunya, M痘 Mpox, 麻疹 Measles, 百日咳 Pertussis,
  流行性腦脊髓膜炎 Meningococcal meningitis, 新型A型流感 Novel influenza A, 小兒麻痺症 Poliomyelitis, 伊波拉 Ebola,
  霍亂 Cholera, 黃熱病 Yellow fever, 茲卡 Zika, 瘧疾 Malaria, 拉薩熱 Lassa fever, 馬堡 Marburg, 立百 Nipah, 白喉 Diphtheria,
  狂犬病 Rabies, 鼠疫 Plague, 恙蟲病 Scrub typhus, 西尼羅熱 West Nile fever, 克里米亞-剛果出血熱 Crimean-Congo haemorrhagic fever).
- Country names in standard short English form; `data/manual/country_names.json` is the reference. Truncated source
  abbreviations: `日` next to 尼日 in the area list = Niger; `印` with 印尼 in the area list = Indonesia; `泊爾` = Nepal.
- Keep source inconsistencies as written; do not reconcile numbers across items.

## Overview rules

- Input per country: `iso`, `name_zh`, `name_en`, `notice_count`, `notices[]` (date, disease, summary) for the past two years.
- `zh`: Traditional Chinese, 2–3 sentences, ≤ 120 characters. `en`: 2–3 sentences, ≤ 70 words.
- Describe which diseases recurred or mattered, rough magnitude/trend when the notices say so, and the most recent
  notable event with month and year. Mention the notice count naturally ("近兩年共 23 則疫情通報" / "23 notices in the past two years").
- Strictly from the notices: no invented facts, no medical advice. When notices are regional or global roundups that
  merely mention the country, say so instead of attributing figures to it.
