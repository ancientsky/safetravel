# 入境航班看板 · 設定指南（給 repo 擁有者 ancientsky）

入境航班看板（`docs/ARRIVALS.md`）需要三件事才會每 10 分鐘更新一次：

1. TDX 的 API 金鑰（存成 GitHub Secrets）
2. 一把只能觸發 workflow 的 GitHub 權杖（PAT）
3. 外部排程服務（cron-job.org）定時呼叫 GitHub，因為 GitHub 自己的 `schedule` 在這個 repo 實測會**晚 4.5–8.5 小時**才開始執行，而手動／API 觸發（`workflow_dispatch`）幾秒內就會開始。

> 任何金鑰、權杖都**不要**貼到聊天室、issue、commit 或程式碼裡。只填在下面指定的設定畫面。

---

## (a) 新增 Repository secrets 與 variable

1. 到 TDX（<https://tdx.transportdata.tw>）會員中心 → 資料服務 → API 金鑰，取得 **Client ID** 與 **Client Secret**（免費方案每月 4,500 次呼叫）。
2. 開啟 <https://github.com/ancientsky/safetravel> → **Settings** → **Secrets and variables** → **Actions**。
3. 在 **Secrets** 分頁按 **New repository secret**，新增兩筆：
   - `TDX_CLIENT_ID` ＝ 你的 Client ID
   - `TDX_CLIENT_SECRET` ＝ 你的 Client Secret
4. （選用）在 **Variables** 分頁按 **New repository variable**：
   - `ARRIVALS_MONTHLY_CAP` ＝ 每月最多呼叫次數，預設 `4200`（留約 300 次給 `update-data.yml` 與手動測試）。

沒有設定 secrets 時，排程觸發的 arrivals 執行會直接結束、什麼都不做；手動執行則會用匿名方式只抓桃園（TPE）測試。

## (b) 建立 Fine-grained personal access token

1. GitHub 右上角頭像 → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**。
2. **Token name**：`cron-job.org safetravel`。
3. **Expiration**：建議 1 年（到期前記得換新並更新 cron-job.org）。
4. **Repository access**：選 **Only select repositories** → 只勾 `ancientsky/safetravel`。
5. **Permissions** → **Repository permissions** → **Actions：Read and write**。其他全部維持 *No access*（Metadata 唯讀是自動附帶的，正常）。
6. 按 **Generate token**，把 `github_pat_…` 複製下來，**只貼進 cron-job.org**（下一步）。離開頁面後就看不到了。

## (c) 在 cron-job.org 建立兩個排程

註冊並登入 <https://cron-job.org>（免費）。**Create cronjob**：

### Job 1：入境航班看板，每 10 分鐘

| 欄位 | 值 |
|---|---|
| Title | `safetravel arrivals` |
| URL | `https://api.github.com/repos/ancientsky/safetravel/actions/workflows/arrivals.yml/dispatches` |
| Schedule | Every 10 minutes（`*/10 * * * *`） |
| Time zone | Asia/Taipei |
| Advanced → Request method | `POST` |
| Advanced → Headers | `Accept: application/vnd.github+json` |
| | `Authorization: Bearer <你的 PAT>` |
| | `X-GitHub-Api-Version: 2022-11-28` |
| | `Content-Type: application/json` |
| Advanced → Request body | `{"ref":"main"}` |
| Expected response | HTTP **204** |

> GitHub 還要求 `User-Agent` 標頭；cron-job.org 預設會帶（`cron-job.org`），不用另外設定。

### Job 2：每日資料更新，11:17 與 21:17（台北時間）

| 欄位 | 值 |
|---|---|
| Title | `safetravel update-data` |
| URL | `https://api.github.com/repos/ancientsky/safetravel/actions/workflows/update-data.yml/dispatches` |
| Schedule | 每天 11:17 與 21:17 |
| Time zone | **Asia/Taipei** |
| Request method / Headers | 同 Job 1 |
| Request body | `{"ref":"main"}` |
| Expected response | HTTP **204** |

這個排程取代 GitHub 自己會晚數小時的 `cron: '17 3,13 * * *'`（已移除；兩個 workflow 都只靠 cron-job.org 觸發，cron-job.org 停用時資料就不會更新）。

兩個 job 都按 **Test run**：看到狀態 `204` 即成功；`401/403` 是權杖錯誤或權限不足、`404` 是網址或 repo 名稱打錯、`422` 是 body 不是 `{"ref":"main"}`。

## (d) 如何確認有在運作

- **Actions 分頁**：<https://github.com/ancientsky/safetravel/actions> 應該每 10 分鐘出現一次 *Arrivals board*。白天（05–24 時）幾乎每次都會執行 *publish* 抓資料並部署；夜間（00–05 時）每 3 次只有 1 次抓資料，其餘只跑完 *guard* 就結束（*publish* 顯示為略過）。資料太新或已達用量上限時也會略過，這是正常的，不耗額度。
- **已發布的檔案**：<https://ancientsky.github.io/safetravel/data/arrivals.json>
  - `generated_at`：最近一次抓取時間（日間應不超過約 20 分鐘前）
  - `source`：`tdx`（有金鑰）或 `tdx-anon`（匿名，僅 TPE）
  - `flights`：視窗內的航班；`airports`：各機場及其航班數
- **用量計數（`quota` 區塊）**：`calls_month` / `cap_month` 為本月已用／上限，`calls_day` 為今日已用。每次抓取 +1（萬一全部機場那次失敗再補抓 TPE 則 +2）。
- 手動測試：Actions → *Arrivals board* → **Run workflow**；勾選 *force* 可略過「資料至少 7 分鐘」的限制（月／日上限仍然有效）。

## (e) 站點專用網址（可加入書籤或放在牆面螢幕）

基底：`https://ancientsky.github.io/safetravel/`

| 用途 | 網址 |
|---|---|
| 桃園 A 檢疫站（T1） | `?arr=TPE-A` |
| 桃園 B（T1） | `?arr=TPE-B` |
| 桃園 C（T2） | `?arr=TPE-C` |
| 桃園 D（T2） | `?arr=TPE-D` |
| 松山 | `?arr=TSA` |
| 高雄 | `?arr=KHH` |
| 大字模式（牆面螢幕） | 任一網址後加 `&big=1`，例如 `?arr=TPE-C&big=1` |

完整範例：<https://ancientsky.github.io/safetravel/?arr=TPE-A>、<https://ancientsky.github.io/safetravel/?arr=KHH&big=1>

## (f) 用量預算與如何調降

TDX 免費方案：每月 4,500 次。

| 項目 | 次數 |
|---|---|
| `update-data.yml`（每天 2 次 × FIDS TPE + 機場清單） | ≤ 4／天 ≈ 124／月 |
| `arrivals.yml` 日間 05:00–23:59（台北），每 10 分鐘 | 19 h × 6 = 114／天 |
| `arrivals.yml` 夜間 00:00–04:59（台北），每 30 分鐘 | 5 h × 2 = 10／天 |
| **合計**（31 天的月份） | ≈ 3,968，剩約 530 次（12 %）供手動執行與重試 |

三道防線（皆不耗額度）：資料未滿 7 分鐘（夜間 25 分鐘）不抓；`calls_month` 達上限不抓；當日用量超過 `min(130, floor((上限 − 今日之前已用) ÷ 本月剩餘天數))` 不抓。因此重複觸發、手動誤按都不會超支。

要降低用量：

- 調降 `ARRIVALS_MONTHLY_CAP`（Settings → Secrets and variables → Actions → Variables），例如 `3000`，系統會自動把每日額度壓低；
- 或把 cron-job.org 的 Job 1 改成每 15 或 20 分鐘；
- 或提高最短間隔：改 `pipeline/arrivals.py` 的 `AGE_DAY_MIN` / `AGE_NIGHT_MIN`。

> 注意：失敗的 TDX 呼叫（連線逾時、5xx）不會寫入 `quota`（失敗時舊檔維持上線），所以真實用量可能略高於顯示值；上限預設留了約 300 次緩衝。

---

## English summary

The arrivals board needs (1) TDX credentials stored as repository secrets `TDX_CLIENT_ID` / `TDX_CLIENT_SECRET` (optional variable `ARRIVALS_MONTHLY_CAP`, default 4200 of the 4,500 free calls/month), (2) a fine-grained PAT limited to `ancientsky/safetravel` with only *Actions: Read and write*, expiry about one year, and (3) two cron-job.org jobs, because GitHub's own cron starts 4.5–8.5 h late here:

- Job 1, every 10 min: `POST https://api.github.com/repos/ancientsky/safetravel/actions/workflows/arrivals.yml/dispatches` with headers `Accept: application/vnd.github+json`, `Authorization: Bearer <PAT>`, `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json` and body `{"ref":"main"}`; expect HTTP 204.
- Job 2, at 11:17 and 21:17 Asia/Taipei: the same request against `update-data.yml`.

Verify in the Actions tab (most runs end at the guard step by design) and at <https://ancientsky.github.io/safetravel/data/arrivals.json> (`generated_at`, `source`, `quota`). Station links: `?arr=TPE-A` … `?arr=TPE-D`, `?arr=TSA`, `?arr=KHH`, add `&big=1` for wall displays. Budget ≈ 3,968 calls in a 31-day month (≈ 530 spare); to use fewer calls lower `ARRIVALS_MONTHLY_CAP`, lengthen the cron-job.org interval, or raise the minimum-age constants. Failed TDX calls are not counted in the published `quota`, so real usage can be slightly higher than shown. Never paste keys or tokens into chat, issues or commits.
