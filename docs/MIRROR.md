# 署內鏡像站（Linux + nginx）部署說明

把 SafeTravel TW 整個網站（疫情地圖、出國前查詢頁 `trip.html`、衛教海報輪播 `slide.html`、入境航班看板）部署在署內 Linux 主機，供 30–50 台 kiosk／牆面螢幕使用，**而且不重覆抓取任何來源資料**。

> English summary at the end.

---

## 1. 運作方式

```
疾管署・外交部・陸委會・TDX・氣象署
            │  只有 GitHub Actions 抓取（每日 11:17／21:17；航班每 10 分鐘）
            ▼
GitHub repo（main 分支 web/：程式＋整理好的資料）   GitHub Pages（另有 data/arrivals.json）
            │                                            │
            └──── 署內主機每 5 分鐘「對外」拉取（git + 一次小下載） ────┘
                                   ▼
             /srv/safetravel/releases/<版本>  ──(原子切換)──>  nginx  ──>  署內 kiosk
```

- **資料只抓一次**：署內主機只從 GitHub 複製「已處理好的成品」，從不連到疾管署、外交部、TDX、氣象署；TDX 每月額度不會多用，API 金鑰也不放在署內主機。
- **兩邊完全一致**：翻譯排程、海報上架（含 `web/slides/auto/` 自動上架）都在 GitHub 完成，署內版 5 分鐘內跟上。
- **只需對外連線**：不需要從外網連進署內；防火牆只要放行署內主機連往 `github.com` 與 `ancientsky.github.io`（TCP 443）。
- **網站不綁網址**：全站只用相對路徑，安全設定（CSP）只允許讀取同一網站，不必改任何程式；預設網址 `https://<署內主機>/safetravel/`，與 GitHub Pages 相同結構。

### 同步程式做的事（`scripts/mirror/safetravel-sync.sh`）

1. `git fetch` main 分支的最新版本（淺層、只取 `web/` 資料夾，第一次約 30 MB，之後每次只下載變動）。
2. 從 GitHub Pages 下載 `data/arrivals.json`（入境航班，不在 git 裡；約 50 KB）。失敗時保留上一份，不影響其他內容。
3. 兩者都沒變 → 什麼都不做（大多數的 5 分鐘都是這樣）。
4. 有變動 → 在 `releases/` 建一個新版本目錄：沒變的檔案用硬連結（幾乎不占空間、不到 1 秒），再檢查：必要檔案都在、**所有 JSON 都能解析**。
5. 寫入 `version.json`（網站程式檔的雜湊，與 GitHub Pages 部署時算出的完全相同），kiosk 據此判斷要不要自動重新載入（見第 5 節）。
6. 檢查通過才用 `rename(2)` 原子切換 `www/safetravel` 這個連結；任何一個請求看到的不是完整舊版就是完整新版，不會讀到更新一半的檔案（實測 600 次切換期間 600 個請求全部 200）。檢查不通過 → 繼續提供舊版，並記錄錯誤。
7. 保留最近 12 個版本（可回復），其餘刪除；寫出狀態檔 `state/status.json`。

---

## 2. 建議規格（30–50 台 kiosk）

### 負載估算（以 50 台計）

| 情境 | 每台行為 | 50 台合計 |
|---|---|---|
| 平時：入境航班看板 | 每 60 秒讀 `arrivals.json`（壓縮後約 6 KB） | 約 50 次／分、40 kbps |
| 平時：疫情地圖 | 每 5 分鐘讀 `meta.json`（< 1 KB） | 約 10 次／分 |
| 平時：海報輪播 | 每 5 分鐘讀 `slides.json`、`auto/index.json` | 約 20 次／分 |
| 尖峰：資料更新（每日 2 次） | 疫情地圖自動重新載入；未變動的檔案只回 304 | 最差（全部重新下載，整站壓縮後約 4 MB）≈ 200 MB 在 1–3 分鐘內，約 10–25 Mbps、每秒數十個請求 |

nginx 送靜態檔案每秒可處理上萬個請求，這個網站的負載對任何一台現代主機都很小；規格主要考量的是作業系統、日誌與可用性，而不是效能。

### 主機規格

| 項目 | 最低 | 建議 |
|---|---|---|
| CPU | 1 vCPU | 2 vCPU |
| 記憶體 | 1 GB | 2–4 GB |
| 磁碟 | 10 GB | 40 GB（作業系統＋日誌；鏡像本身含 12 個版本約 50 MB） |
| 網路 | 100 Mbps | 1 Gbps |
| 作業系統 | Ubuntu 22.04／24.04 LTS，或 RHEL／Rocky／AlmaLinux 8、9 | 同左（有安全更新的 LTS 版本） |
| 形式 | 一台 VM 即可 | 要求不中斷時：兩台 VM ＋ 負載平衡器或 keepalived 虛擬 IP，**兩台各自執行同步**（各自從 GitHub 拉，不需要共用儲存） |

存取日誌估計：平時約每分鐘 80 筆，一天約 12 萬筆（約 25 MB），交給系統的 logrotate 每日輪替、保留 14 天即可。

### 前置需求

- 套件：`nginx`（1.18 以上）、`git`（2.27 以上，需支援 sparse-checkout 與 partial clone）、`curl`、`rsync`、`python3`（任何 3.x，只用來檢查 JSON）、`util-linux`（`flock`）。
  - Ubuntu：`sudo apt install nginx git curl rsync python3`
  - RHEL 系列：`sudo dnf install nginx git curl rsync python3 policycoreutils-python-utils`
- 對外連線（TCP 443）：`github.com`、`ancientsky.github.io`。若署內經由 proxy 上網，在 `/etc/safetravel/mirror.env` 設 `HTTPS_PROXY`；若 proxy 會解開 TLS 檢查，請把 proxy 的 CA 加入系統信任（Ubuntu `update-ca-certificates`、RHEL `update-ca-trust`）。
- NTP 校時（主機與 kiosk 都要）。
- 署內 CA 簽發的 TLS 憑證（見第 5 節「為什麼要 HTTPS」）。

---

## 3. 安裝

```bash
git clone https://github.com/ancientsky/safetravel.git /opt/safetravel-src
sudo bash /opt/safetravel-src/scripts/mirror/install.sh
```

`install.sh` 會（可重複執行）：

1. 建立系統帳號 `safetravel`（無登入 shell）與目錄 `/srv/safetravel/{repo,releases,www,state,tmp}`。
2. 安裝 `/opt/safetravel/safetravel-sync.sh`、`/etc/safetravel/mirror.env`（已存在則不覆蓋）、systemd 的 `safetravel-sync.service` 與 `safetravel-sync.timer`。
3. SELinux 開啟時（RHEL 系列）把 `/srv/safetravel` 標記為 `httpd_sys_content_t`，nginx 才讀得到。
4. 把 nginx 範本放到 `/etc/nginx/conf.d/safetravel.conf.disabled`（**不會自動啟用**）。
5. 立即同步一次，並啟用每 5 分鐘的 timer，最後印出 `--check` 結果。

接著設定 nginx（第 4 節）：

```bash
sudo vi /etc/nginx/conf.d/safetravel.conf.disabled     # 改主機名稱與憑證路徑（標 ← 的行）
sudo mv /etc/nginx/conf.d/safetravel.conf.disabled /etc/nginx/conf.d/safetravel.conf
sudo nginx -t && sudo systemctl reload nginx
curl -I https://<署內主機>/safetravel/                  # 應回 200
```

不用 `install.sh` 也可以手動安裝：照上面的清單複製 `scripts/mirror/` 的檔案到相同位置，建立帳號與目錄（擁有者 `safetravel`），`systemctl daemon-reload && systemctl enable --now safetravel-sync.timer`。

### 檔案一覽

| 檔案（repo 內） | 安裝位置 | 用途 |
|---|---|---|
| `scripts/mirror/safetravel-sync.sh` | `/opt/safetravel/safetravel-sync.sh` | 同步程式（也提供 `--check`、`--rollback`） |
| `scripts/mirror/mirror.env.example` | `/etc/safetravel/mirror.env` | 設定（來源網址、proxy、保留版本數、監控門檻） |
| `scripts/mirror/safetravel-sync.service` | `/etc/systemd/system/` | 執行一次同步（以 `safetravel` 帳號、唯讀系統、只能寫 `/srv/safetravel`） |
| `scripts/mirror/safetravel-sync.timer` | `/etc/systemd/system/` | 開機 2 分鐘後首次執行，之後每 5 分鐘 |
| `scripts/mirror/nginx-safetravel.conf` | `/etc/nginx/conf.d/safetravel.conf` | nginx 站台設定 |
| `scripts/mirror/install.sh` | — | 安裝／更新上述檔案 |

### 目錄結構（`/srv/safetravel`）

```
repo/                      git 工作目錄（只含 web/）
releases/20261103T072941Z-b331180/   各版本（UTC 時間－commit），未變動檔案彼此硬連結
www/safetravel -> ../releases/<目前版本>   nginx 讀的位置（原子切換）
state/status.json          最近一次同步結果（也可從 /safetravel/_mirror/status.json 讀取）
state/arrivals.json        最後一份成功下載的航班資料
state/last_success         最後一次成功同步的時間（--check 用）
tmp/                       建置中的版本（與 releases 同一檔案系統，切換才是原子操作）
```

---

## 4. nginx 設定說明

完整檔案：[`scripts/mirror/nginx-safetravel.conf`](../scripts/mirror/nginx-safetravel.conf)。重點：

| 設定 | 說明 |
|---|---|
| `root /srv/safetravel/www;` + `location /safetravel/` | 網址 `/safetravel/…` 對應 `www/safetravel/…`（即目前版本）。想用獨立主機名稱且不要子路徑時，可把 `location /` 的 root 指到 `/srv/safetravel/www/safetravel`；網站只用相對路徑，兩種都可以。 |
| `location = /` → 302 `/safetravel/`、`/safetravel` → 301 `/safetravel/` | 打主機名稱或少打斜線都會導到首頁。 |
| 80 → 443 轉址 | kiosk 一律用 HTTPS。 |
| `Cache-Control: no-cache`（HTML、JS、CSS、JSON） | 本站檔名沒有版本雜湊，所以每次都向伺服器確認；未變動時只回 **304**（幾百 bytes），既即時又省流量。 |
| `Cache-Control: public, max-age=3600`（圖片） | 圖片快取 1 小時。 |
| `gzip`（JSON、JS、CSS、SVG） | `epidemics.json` 1.3 MB → 305 KB、`arrivals.json` 50 KB → 6 KB。 |
| `X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options` | 基本安全標頭。**不要另加 `Content-Security-Policy` 標頭**：每個頁面已有自己的 CSP `<meta>`（含內嵌腳本的雜湊），兩者不同會互相限制而讓頁面壞掉。 |
| `location ~ /\.` → 403 | 不提供隱藏檔。 |
| `/safetravel/_mirror/status.json` | 同步狀態（JSON），給監控或維運人員查看；可用 `allow`／`deny` 限定網段。 |
| **不要開 `open_file_cache`** | nginx 每個請求都要重新解析 `www/safetravel` 連結，切換版本才會立刻生效；若一定要開，`open_file_cache_valid` 請設幾秒以內。 |
| `listen 443 ssl http2;` | nginx 1.25.1 以上也可改成 `listen 443 ssl;` ＋ `http2 on;`。主機停用 IPv6 時刪除 `listen [::]:…` 兩行。 |

MIME 類型：網站需要 `.json`（`application/json`）、`.js`（`application/javascript` 或 `text/javascript`；網頁以 ES 模組載入，類型錯誤會載不到）、`.webp`、`.svg`；若日後上架 AVIF 圖片則需 `.avif`。確認方式：`grep -E 'json|javascript|webp|avif|svg' /etc/nginx/mime.types`，缺少的請在該檔加上（例如 `image/avif avif;`）。

實測（nginx 1.24）：首頁、`trip.html`、`slide.html`、各 JSON、圖片、狀態檔皆 200 且類型正確；`.gitignore` 403；JSON 以 gzip 傳送；帶 ETag 的重複請求回 304；三組瀏覽器自動測試（主頁 22 項、`trip.html` 24 項、`slide.html` 24 項）透過 nginx 鏡像全部通過。

---

## 5. Kiosk 設定建議

- **網址**（把 `<署內主機>` 換成實際名稱；參數與 GitHub Pages 版完全相同，見 README「直接連結」）：
  - 疫情地圖＋入境航班看板：`https://<署內主機>/safetravel/?arr=TPE-C&big=1`
  - 出國前查詢頁：`https://<署內主機>/safetravel/trip.html`
  - 衛教海報輪播：`https://<署內主機>/safetravel/slide.html`（橫式螢幕加 `?orient=landscape`）
- **為什麼要 HTTPS**：海報輪播用瀏覽器的 Screen Wake Lock 防止螢幕休眠，這個功能只在 HTTPS（安全連線）下可用；請在 kiosk 上安裝署內 CA 憑證。若暫時只能用 HTTP，請在 kiosk 作業系統把「螢幕關閉／睡眠」設為「永不」。
- **校時**：海報的上架／下架日期與航班時間窗都依 kiosk 本機時間（臺北時區）判斷，kiosk 請開啟 NTP。
- **瀏覽器**：Chrome／Edge 的 kiosk 模式（例如 `--kiosk https://…`），關閉自動翻譯提示與「還原分頁」提示。
- **自動更新**（不需要人去按重新整理）：同步程式會為每個版本寫入 `version.json`（網站程式檔的雜湊，資料不算在內），三個頁面每 5 分鐘檢查一次，有變動時在不打擾使用的時機自動重新載入：
  - 疫情地圖（首頁）：資料或程式更新時，在下一次焦點輪播切換（或偵測後 1 分鐘）重新載入；有人正在操作時會延後，最多延後 2 分鐘（與原本的資料更新行為相同）。
  - 海報輪播：程式更新時在換下一張海報的瞬間重新載入；海報上架／下架則是每 5 分鐘直接更新，不必重新載入。暫停播放時改為 1 分鐘無人操作後重新載入。
  - 出國前查詢頁：資料或程式更新時，**連續 5 分鐘沒有任何操作**才重新載入，正在查詢的人不會被打斷；網址中的國家（例如 `#JP`）會保留。
  - 三個頁面開著超過 24 小時也會在同樣的時機重新載入一次（長時間執行的保險）。
- **時效**：署內版比 GitHub Pages 最多晚約 5 分鐘（同步間隔），kiosk 再於 5 分鐘內偵測到並重新載入。

---

## 6. 日常維運

| 要做的事 | 指令 |
|---|---|
| 看同步紀錄 | `journalctl -u safetravel-sync.service -n 50`（或 `--since today`） |
| 看下次同步時間 | `systemctl list-timers safetravel-sync.timer` |
| 立即同步一次 | `sudo systemctl start safetravel-sync.service` |
| 狀態（JSON） | `cat /srv/safetravel/state/status.json` 或 `https://<署內主機>/safetravel/_mirror/status.json` |
| 健康檢查 | `/opt/safetravel/safetravel-sync.sh --check`（見下） |
| 回到上一版 | `sudo -u safetravel /opt/safetravel/safetravel-sync.sh --rollback` |
| 暫停同步（固定在目前版本） | `sudo systemctl stop safetravel-sync.timer`（恢復：`start`） |
| 重新取得 git 資料（例如磁碟出錯） | `sudo rm -rf /srv/safetravel/repo && sudo systemctl start safetravel-sync.service` |
| 更新同步程式本身 | `cd /opt/safetravel-src && git pull && sudo bash scripts/mirror/install.sh` |

`status.json` 範例：

```json
{
  "last_attempt": "2026-11-03T15:29:41+0800",
  "result": "ok",
  "message": "published 20261103T072941Z-b331180",
  "last_success": "2026-11-03T15:29:41+0800",
  "commit": "b331180ef2d2e8dbf609b0d95acc140ef0e48612",
  "release": "20261103T072941Z-b331180",
  "data_generated_at": "2026-11-03T11:54:19+08:00",
  "arrivals_generated_at": "2026-11-03T15:30:00+08:00"
}
```

### 監控（`--check`）

輸出一行文字，結束碼 0＝OK、1＝WARNING、2＝CRITICAL（Nagios／Zabbix／NRPE 皆可直接使用）：

```
OK - SafeTravel mirror: synced 2 min ago data 3 h old release 20261103T072941Z-b331180
WARNING - SafeTravel mirror: last successful sync 45 min ago …
CRITICAL - SafeTravel mirror: last successful sync 180 min ago …
```

- 同步失敗超過 30 分鐘 → WARNING、超過 120 分鐘 → CRITICAL（`WARN_AFTER_MIN`／`CRIT_AFTER_MIN`）。
- 資料（`meta.json`）超過 26 小時沒更新 → WARNING：代表上游（GitHub Actions）的每日更新停了，請通知網站維護者；署內主機本身沒有問題。
- Zabbix 範例：`UserParameter=safetravel.mirror,/opt/safetravel/safetravel-sync.sh --check`（任何帳號都可執行，只讀取狀態檔）。

### 失敗時會怎樣

| 狀況 | 結果 |
|---|---|
| 對外網路中斷、GitHub 暫時無法連線 | 繼續提供最後一個版本；恢復後下一次同步自動追上。`--check` 30 分鐘後轉 WARNING。 |
| 只有 `arrivals.json` 下載失敗 | 保留上一份航班資料，其餘照常更新；航班看板會依資料時間顯示「資料延遲」提示。 |
| 新版本有壞掉的 JSON 或缺檔 | 不切換，繼續提供舊版；`status.json` 的 `result` 為 `error` 並寫明原因。 |
| 兩次同步重疊 | 第二個直接跳過（檔案鎖）。 |
| 回復後 | `--rollback` 的版本會一直使用到 GitHub 下一次有新內容；要固定就停 timer。 |

---

## 7. 疑難排解

| 現象 | 檢查 |
|---|---|
| nginx 回 403（RHEL 系列） | SELinux 標籤：`ls -Z /srv/safetravel/www`，應為 `httpd_sys_content_t`；重新執行 `install.sh` 或 `restorecon -R /srv/safetravel`。 |
| 網頁空白、主控台出現 module／MIME 錯誤 | `.js` 的 Content-Type 必須是 JavaScript 類型；檢查 `mime.types`（第 4 節）。 |
| `git` 連不上 | `sudo -u safetravel HTTPS_PROXY=… git ls-remote https://github.com/ancientsky/safetravel.git`；proxy 設在 `mirror.env`；TLS 檢查型 proxy 需匯入其 CA。 |
| `arrivals.json not refreshed` 警告偶爾出現 | GitHub Pages 偶發延遲，保留上一份即可；長時間持續請檢查到 `ancientsky.github.io` 的連線。 |
| 海報輪播螢幕會休眠 | 使用 HTTPS（Wake Lock），或把 kiosk 的螢幕休眠設為永不。 |
| 署內版與 GitHub Pages 不一樣 | 看 `status.json` 的 `commit` 與 `last_success`；`systemctl start safetravel-sync.service` 立即同步。 |

---

## English summary

An intranet mirror that serves the whole site from a Linux host with nginx **without fetching any source twice**: GitHub Actions remains the only process that talks to Taiwan CDC, MOFA/BOCA, MAC, TDX and CWA, and the mirror copies its output.

- `scripts/mirror/safetravel-sync.sh` (systemd timer, every 5 min, user `safetravel`): shallow, sparse, blob-less `git fetch` of `web/` on `main`, plus `data/arrivals.json` from GitHub Pages (the only file not in git). Nothing new → no-op. Otherwise it builds `releases/<UTC time>-<commit>` with `rsync --link-dest` (unchanged files hard-linked), checks required files and that every JSON parses, then switches `www/safetravel` with an atomic rename (600/600 requests returned 200 during 600 switches). A failed check keeps the current release. Keeps 12 releases; `--rollback` serves the previous one; `--check` is a Nagios/Zabbix-style probe (sync age, upstream data age); `state/status.json` is also served at `/safetravel/_mirror/status.json`.
- `scripts/mirror/nginx-safetravel.conf`: HTTPS (80 → 443), `/safetravel/` sub-path like GitHub Pages, `Cache-Control: no-cache` for text (cheap 304s, as file names are not fingerprinted) and 1 h for images, gzip, basic security headers, no CSP header (the pages carry their own CSP meta with a script hash), hidden files denied, no `open_file_cache`.
- `scripts/mirror/install.sh`: user, directories, units, SELinux labels, nginx template (not enabled automatically), first sync.
- Sizing for 30–50 kiosks: steady state ≈ 80 requests/min and well under 1 Mbps; the twice-daily data reload peaks at a few hundred MB over 1–3 minutes in the worst case. 1 vCPU / 1 GB / 10 GB is enough; 2 vCPU / 2–4 GB / 40 GB recommended; for high availability run two VMs behind a load balancer or keepalived VIP, each syncing on its own. Outbound HTTPS to `github.com` and `ancientsky.github.io` only; set `HTTPS_PROXY` in `/etc/safetravel/mirror.env` if needed. Serve kiosks over HTTPS (Screen Wake Lock needs a secure context) and keep kiosk clocks on NTP. The sync also writes `version.json` (hash of the site's code files, identical to the GitHub deploys' `.github/scripts/stamp-version.sh`); the map, trip and poster pages poll it and reload themselves at a quiet moment, so kiosks never need a manual refresh.
