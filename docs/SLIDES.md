# 衛教海報輪播（slide.html）維護說明

機場檢疫站螢幕用的疾管署衛教海報輪播：<https://ancientsky.github.io/safetravel/slide.html>

- 每張海報是 **HTML 即時排版**（文字可改、可翻譯、放大不糊），有短暫的進場動畫（≤ 約 1.5 秒），之後只剩輕微的待機動態。
- 預設**直式 1080×1920**，也有**橫式 1920×1080** 的獨立版面；畫面會自動縮放置中，適合任何解析度的螢幕。
- 海報清單在 **`web/slides/slides.json`**，改這一個檔就能新增、下架或排程海報；開著的螢幕**每 5 分鐘**重新讀取，不必重新整理。
- **最簡單的上架方式**：把海報圖檔丟進 **`web/slides/auto/`** 資料夾就會自動播放，刪掉就下架，不用改任何設定檔（見 2-0）。
- 每次海報更新後，GitHub Actions 會自動輸出 **PNG（直式＋橫式）**，在設定面板的「下載」可取得；**PDF** 用面板的「列印／存成 PDF」（目的地選「另存為 PDF」）即可。

> English summary at the end.

---

## 1. 下架一張海報

在 `web/slides/slides.json` 找到那張海報，擇一：

```jsonc
{ "id": "ebola-drc-zh", "template": "alert", "active": false, ... }   // 立刻停用
{ "id": "ebola-drc-zh", "template": "alert", "active": true, "until": "2026-12-31", ... }   // 播到 12/31（含）為止
```

- `from` / `until` 以**臺北時間的日期**判斷（含當天）。到期當天午夜後，開著的螢幕在下一次換張時就會自動跳過，不必改任何東西。
- 也可以先寫好 `from`（例如新疫情公告日），到日期才開始播放。
- 只想讓「某一台螢幕」不播某張：在那台螢幕的設定面板取消勾選即可（存在該瀏覽器的 localStorage，不影響其他螢幕）。

## 2. 新增一張海報

### 2-0. 最簡單：把圖檔丟進 `web/slides/auto/`（自動上架）

不需要編輯 JSON。在 GitHub 網頁開啟 [`web/slides/auto/`](../web/slides/auto/) →「Add file」→「Upload files」→ 拖入圖檔 →「Commit changes」。約 2–3 分鐘後網站更新，開著的螢幕在 5 分鐘內開始播放。

- 支援 PNG / JPG / WebP / GIF / AVIF；建議長邊 2000 px 以內、2 MB 以下（超過 5 MB 會在 Actions 出現警告）。檔名可以用中文、空格。
- **下架**：刪除檔案。**暫停**（保留檔案）：檔名開頭加 `_`，例如 `_猴痘宣導.png`。
- 播放順序：在 `slides.json` 的海報之後，依檔名排序；檔名開頭的數字（`01_`、`02_`）只用來排序，不會出現在標題。
- 其他設定直接寫在**檔名**裡，用 `_` 或空格分隔（全形數字也可以）：

| 檔名裡的字 | 意思 | 英文寫法 |
|---|---|---|
| `上架2026-11-10` | 這天起才播放（臺北時間） | `from2026-11-10` |
| `下架2026-12-31` | 播到這天（含）為止 | `until2026-12-31` |
| `10秒` | 這張停留秒數（3–60） | `10s` |
| `直式` / `橫式` | 同一張海報的直式版／橫式版：直式螢幕放直式那張、橫式螢幕放橫式那張 | `portrait` / `landscape` |
| `中文` / `英文` / `雙語` | 海報語言（給設定「海報語言」篩選用；未標示視為中文） | `zh` / `en` / `bi` |
| `加頁尾` | 在圖片下方加疾管署頁尾（預設不加，因為完整海報通常已有自己的頁尾） | `brand` |

例：

```
01_猴痘宣導_下架2026-12-31_10秒_直式.png
01_猴痘宣導_橫式.png              ← 同一張海報的橫式版（設定寫在任一張即可）
02_登革熱防蚊_英文.jpg            ← 只有一張：直式、橫式螢幕都用它（自動等比例縮放，兩側以模糊背景補滿）
```

背後的運作：`python -m pipeline.slides_auto` 掃描資料夾，產生 `web/slides/auto/index.json`（不要手動編輯），網頁把它接在 `slides.json` 後面。海報匯出流程（`slides.yml`）與 Pages 部署都會先執行它。檔名寫錯（例如不存在的日期 `下架2026-02-30`、上架晚於下架、兩個直式版）時，海報匯出流程會失敗並在 Actions 標出是哪個檔案；Pages 部署則只略過那個檔案，其他內容照常上線。修正檔名後重新上傳即可。

### 2-1. 整張圖片寫進 slides.json（`image` 樣板）

適合疾管署已經做好的海報檔（PNG / JPG / WebP），而且想跟其他海報一起排順序、或寫英文說明時使用；只是要上架一張圖，用 2-0 的資料夾更簡單。

1. 把圖檔放到 `web/slides/assets/`（檔名只用英數、`-`、`_`、`.`，例如 `mpox-2027.png`；建議長邊 2000 px 以內、2 MB 以下）。
2. 在 `slides.json` 的 `slides` 陣列加一筆：

```json
{
  "id": "mpox-2027",
  "template": "image",
  "active": true,
  "lang": "zh",
  "from": "2027-01-15",
  "src": "slides/assets/mpox-2027.png",
  "alt": "M痘衛教海報：入境如有發燒、皮疹請主動告知檢疫人員"
}
```

圖片會等比例完整顯示（直式海報放在橫式螢幕時，兩側用模糊的同一張圖補滿），並有緩慢的推近（Ken Burns）效果。`alt` 必填（給螢幕報讀與無障礙）。另有橫式版時加 `"src_landscape": "slides/assets/mpox-2027-wide.png"`，橫式螢幕就會改放那一張。整張圖片的海報通常已有自己的頁尾，所以預設不加疾管署頁尾；要加的話寫 `"brand": true`。

### 2-2. 用樣板（文字可改、雙語、直橫式各自排版）

每張都要有共用欄位：`id`、`template`、`active`、`lang`（`zh` 中文、`en` 英文、`bi` 雙語），可選 `from`、`until`、`duration`（這張停留秒數，覆蓋全域間隔）。

**重點字**一律用「片段陣列」，不要寫 HTML（頁面只會把文字當文字顯示）：

```json
"rule": [{ "t": "須主動向" }, { "t": "疾管署檢疫站報到", "hl": true }, { "t": "\n並配合入境後自主健康管理 21 天" }]
```

`"hl": true` 的片段會變成強調色並有掃過的底線動畫；`\n` 是換行。一般欄位寫成字串也可以。

#### `alert`：疫情警示（紫／黃，附地圖）

```json
{
  "id": "ebola-drc-zh", "template": "alert", "lang": "zh", "active": true, "from": "2026-10-01",
  "kicker": "請注意",
  "category": "國際疫情",
  "disease": "伊波拉",
  "region_label": "流行地區",
  "country": "剛果民主共和國",
  "country_en": "Democratic Republic of the Congo (DRC)",
  "iso": "CD",
  "status": "WHO 列為「國際關注公共衛生緊急事件」",
  "ask": [{ "t": "過去 " }, { "t": "21 天內", "hl": true }, { "t": "曾到過剛果民主共和國？" }],
  "rule": [{ "t": "須主動向" }, { "t": "疾管署檢疫站報到", "hl": true }, { "t": "\n並配合入境後自主健康管理 21 天" }],
  "note": "依據臺灣法令規定"
}
```

`iso` 是流行國家的 ISO 兩碼，會畫出該國到臺灣的航線地圖（不填就不顯示地圖）。必填：`kicker`、`disease`、`country`、`rule`。

#### `symptoms`：症狀提醒（吉祥物＋症狀圖示）

```json
{
  "id": "healthy-travel", "template": "symptoms", "lang": "bi", "active": true, "duration": 10,
  "title": "台灣美 健康玩",
  "subtitle": "Beautiful Taiwan, healthy traveling",
  "intro": { "zh": "有以下任何一項症狀？", "en": "Any of these symptoms?" },
  "symptoms": [ { "icon": "slides/assets/sym-fever.webp", "zh": "發燒", "en": "Fever" } ],
  "steps": [
    { "zh": [{ "t": "儘速就醫", "hl": true }, { "t": "，或告知隨團領隊及導遊" }],
      "en": [{ "t": "Seek medical care", "hl": true }, { "t": " and tell your tour guide" }],
      "note": { "zh": "就醫時請告知醫師最近的旅遊史及接觸史", "en": "Tell your doctor about your recent travel and contact history" } }
  ],
  "mascot": "slides/assets/mascots.webp"
}
```

標題的空格會讓直式版分成兩行。症狀建議 4～8 個；`symptoms`、`steps` 必填。

#### `report`：入境報到（檢疫櫃台插畫）

```json
{
  "id": "report-zh", "template": "report", "lang": "zh", "active": true,
  "headline": "入境旅客請注意",
  "symptoms": [ { "icon": "fever", "t": "發燒" }, { "icon": "cough", "t": "咳嗽" } ],
  "tail": "等身體不適",
  "condition": [{ "t": "無論是否服用" }, { "t": "退燒藥、止咳藥", "hl": true }],
  "cta": [{ "t": "主動", "hl": true }, { "t": "向機場／港口" }, { "t": "檢疫人員報到", "hl": true }],
  "sign": { "zh": "旅客檢疫", "en": "Quarantine" }
}
```

`icon` 可用 `fever`（體溫計）、`cough`（咳嗽）、`breath`（肺）、`unwell`（不適）。插畫是程式畫的 SVG：旅客會走向櫃台，櫃台招牌文字就是 `sign`。

#### `germs`：別把病菌帶回國（雙語）

```json
{
  "id": "no-germs", "template": "germs", "lang": "bi", "active": true,
  "headline": { "zh": "小心別把病菌帶回國", "en": "Don’t bring germs back to Taiwan" },
  "message": {
    "zh": [{ "t": "入境時如身體不適，請" }, { "t": "主動通知檢疫人員", "hl": true }],
    "en": [{ "t": "Feeling unwell upon arrival? Please " }, { "t": "inform quarantine officers", "hl": true }, { "t": " at the airport immediately." }]
  },
  "art": "slides/assets/pests.webp"
}
```

#### 頁尾（全部樣板共用）

`slides.json` 最上層的 `brand`：疾管署標誌（`slides/assets/cdc-logo.png`，放在白色圓底上）、機關名稱、`疫情通報及關懷專線 1922`、網址（只接受 `https://…cdc.gov.tw`）。改這裡就會套用到每一張。頁尾不隨海報語言變化：每一張都顯示同樣的中英文內容、同樣的高度與位置，輪播時不會跳動。

### 2-3. 改了之後

```bash
python -m pipeline.validate web           # 檢查 slides.json（不需安裝套件；Pages 部署與海報匯出都會先跑）
python -m http.server -d web 8080         # 預覽 http://localhost:8080/slide.html
```

檢查會擋下：未知樣板、缺欄位或多打錯的欄位名稱、重複 `id`、日期格式（YYYY-MM-DD）或不存在的日期、`from` 晚於 `until`、圖片路徑不在 `web/slides/assets/` 或檔案不存在、`hl` 不是 true/false、看起來像 HTML 的文字。以底線開頭的欄位（例如 `"_comment"`）會被忽略，可以拿來寫備註。所有 Pages 部署流程都會執行這個檢查，打錯字不會讓輪播壞掉上線。

## 3. 播放設定

| 設定 | 預設 | 說明 |
|---|---|---|
| 每張秒數 | 5 | 3–60 秒；海報自己的 `duration` 優先（例如症狀海報 10 秒）。`slides.json` 的 `interval` 可改全站預設。 |
| 螢幕方向 | 直式 | 直式 1080×1920、橫式 1920×1080、自動（依螢幕長寬） |
| 海報語言 | 全部 | 只播中文（含雙語）或英文（含雙語） |
| 本螢幕播放的海報 | 全勾 | 取消勾選只影響這台螢幕 |

設定面板平常隱藏：**移動滑鼠或點一下螢幕**就會出現，3 秒沒動作自動隱藏（游標也會隱藏）；按 `S` 鍵開啟並固定。快捷鍵：`←` / `→` 上一張／下一張、空白鍵暫停、`F` 全螢幕、`Esc` 關閉面板。播放中會要求螢幕保持喚醒（Wake Lock，瀏覽器支援時）。設定存在該瀏覽器的 localStorage（`safetravel.slide.*`）。

**網址參數**（優先於面板設定，適合做成螢幕的開機網址）：

| 網址 | 效果 |
|---|---|
| `slide.html?interval=8` | 每張 8 秒 |
| `slide.html?orient=landscape` | 橫式（`portrait` / `auto`） |
| `slide.html?only=ebola-drc-zh,report-zh` | 只播這幾張（仍受 `active`／`from`／`until` 限制） |
| `slide.html?lang=en` | 只播英文與雙語海報，面板也用英文（`zh` 中文、`all` 全部） |
| `slide.html?slide=healthy-travel` | 從某一張開始 |
| `slide.html?play=0` | 開啟時先暫停 |
| `slide.html?still=1` | 靜態（動畫停在最後畫面、不顯示控制項；匯出用） |

例如機場 C 檢疫站的橫式螢幕：`slide.html?orient=landscape&interval=8`。

## 4. 列印與 PNG／PDF 下載

- **瀏覽器列印**：面板的「列印／存成 PDF」（或 Ctrl+P）會輸出目前播放清單的每一張，一張一頁，頁面大小依目前方向（1080×1920 或 1920×1080），動畫為最後畫面，背景色一併列印。
- **自動匯出**：`.github/workflows/slides.yml` 在 `web/slides/**`（`export/` 除外）、`slide.html`、`slide.css`、`js/slide*.js` 或 `scripts/export-slides.mjs` 推上 `main` 時執行（也可手動 Run workflow）：檢查 `slides.json` → 用 Playwright + Chromium（安裝 Noto Sans CJK 字型）開啟 `slide.html?still=1` → 每張輸出直式、橫式 PNG → 寫入 `web/slides/export/` 與 `index.json` → 有變動才提交到 `main`（PNG 輸出是確定性的，沒改的海報不會產生新檔；PDF 每次都帶時間戳記且檔案大，所以不放進 repo，本機需要時可加 `--pdf-dir 目錄` 另外輸出），再觸發 `deploy-pages.yml` 重新部署。面板的「下載」讀 `index.json`；若匯出比目前的 `slides.json` 舊會提示。
- 本機手動匯出：

```bash
python -m http.server -d web 8150 &
CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/export-slides.mjs http://localhost:8150/
```

## 5. 插圖從哪裡來

- 症狀圖示（7 個）、兩隻吉祥物、蒼蠅與老鼠：由疾管署原始海報裁切去背（只取插圖，不取海報上的文字）。原檔在 `scripts/slide-sources/`，重新產生：`/usr/bin/python3 scripts/crop-slide-assets.py`（需要 Pillow 與 numpy）。
- 疾管署標誌：`scripts/slide-sources/cdc-logo.png` 縮成 512×512 → `web/slides/assets/cdc-logo.png`，不改色、不變形。
- 地圖（`alert`）、檢疫櫃台與旅客、行李箱與病菌、禁止標誌：程式繪製的 SVG（`web/js/slide-templates.js`），顏色在 `web/slide.css`。

## 6. 欄位參考

| 欄位 | 型別 | 說明 |
|---|---|---|
| `version` | 1 | 檔案格式版本 |
| `interval` | 3–60 | 全站預設每張秒數（可省略，預設 5） |
| `brand` | 物件 | 頁尾：`logo`、`org_zh`、`org_en`、`hotline_zh`、`hotline_en`、`hotline`、`url`（cdc.gov.tw） |
| `slides[].id` | 字串 | 英數、`-`、`_`，最多 64 字，不可重複；也是 PNG 檔名 |
| `slides[].template` | 字串 | `alert`、`symptoms`、`report`、`germs`、`image` |
| `slides[].active` | true/false | 是否播放 |
| `slides[].lang` | 字串 | `zh`、`en`、`bi` |
| `slides[].from` / `until` | YYYY-MM-DD | 臺北時間，含當天；可只寫其中一個 |
| `slides[].duration` | 2–600 | 這張停留秒數 |
| `slides[].alt` | 字串 | 替代文字（`image` 必填） |
| 文字欄位 | 字串或片段陣列 | `[{ "t": "文字" }, { "t": "重點", "hl": true }]`，`\n` 換行 |
| 雙語欄位 | `{ "zh": …, "en": … }` | `intro`、`note`、`sign`、`germs` 的 `headline`／`message` |
| 圖片欄位 | `slides/assets/<檔名>` | png、webp、jpg、svg、gif、avif |

各樣板的必填／選填欄位見第 2 節，完整規則在 `pipeline/validate.py` 的 `SLIDE_FIELDS`。

---

## English summary

`web/slide.html` is an auto-advancing, data-driven carousel of Taiwan CDC health-education posters for airport quarantine-station screens: live HTML text, short entrance animations (≤ ~1.5 s) then calm idle motion, portrait 1080×1920 by default plus a separate landscape 1920×1080 layout, scaled to fit any screen.

- **Playlist**: `web/slides/slides.json`. Retire a poster with `"active": false` or an `until` date (Asia/Taipei, inclusive); schedule one with `from`. Open screens re-read the file every 5 minutes and re-check dates on every slide change.
- **Auto-publish folder**: drop an image into `web/slides/auto/` (GitHub web: Add file → Upload files) and it plays after the manifest's posters, ordered by file name; delete it to retire it, prefix `_` to pause it. Settings ride in the file name, words separated by `_` or spaces: `上架YYYY-MM-DD`/`fromYYYY-MM-DD`, `下架YYYY-MM-DD`/`untilYYYY-MM-DD`, `10秒`/`10s`, `直式`/`橫式` (portrait/landscape versions of one poster), `中文`/`英文`/`雙語` (zh/en/bi), `加頁尾`/`brand`; a leading number only orders. `python -m pipeline.slides_auto` writes `web/slides/auto/index.json` (generated; run by the export workflow, which fails on a bad name, and by the Pages deploy with `--lenient`, which skips the bad file).
- **Add a poster**: quickest is the `image` template (`src_landscape` optional) — drop the file into `web/slides/assets/` and add `{ "id", "template": "image", "active", "lang", "src": "slides/assets/<file>", "alt" }` (shown whole with a slow Ken Burns zoom). Or use a template — `alert`, `symptoms`, `report`, `germs` — with the fields in section 2 (highlights are segment arrays `[{"t": "…", "hl": true}]`, never HTML).
- **Settings** (appear on mouse move / tap, hide after 3 s; `S` pins): seconds per poster (default 5, 3–60; a poster's `duration` wins), orientation (portrait / landscape / auto), poster language, per-screen show/hide, print, downloads. Keys: ←/→, Space, F, Esc. URL parameters override stored settings: `?interval=8&orient=landscape&only=id1,id2&lang=en` (`slide=`, `play=0`, `still=1` too). Screen Wake Lock while playing.
- **Print / PDF**: the browser print outputs every playlist slide, one per page, at the current orientation, final animation state, backgrounds included.
- **PNG + PDF export**: `.github/workflows/slides.yml` runs `scripts/export-slides.mjs` (Playwright/Chromium against `slide.html?still=1`) on poster changes, commits `web/slides/export/` (PNG per slide and orientation + `index.json`, only when something changed) and dispatches `deploy-pages.yml`. PDF: the page's Print / Save as PDF (or `--pdf-dir DIR` locally); PDFs are not committed because they embed a timestamp and are large.
- **Validation**: `python -m pipeline.validate web` (stdlib; run by the Pages deploy on every push to web/ and by the export workflow — deliberately not by the data / arrivals deploys, so a manifest typo can never stop the quarantine board) rejects unknown templates, missing or misspelt fields, duplicate ids, bad dates, missing asset files, non-boolean `hl` and HTML-looking text. Keys starting with `_` are ignored (comments).
- **Artwork**: symptom badges, mascots and the fly/rat are cut out of the original CDC posters (`scripts/slide-sources/`, `scripts/crop-slide-assets.py`); the CDC seal is the supplied logo; maps, the quarantine counter scene, suitcase and germs are SVG drawn in `web/js/slide-templates.js`.
