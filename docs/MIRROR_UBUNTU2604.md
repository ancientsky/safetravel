# 署內鏡像站：Ubuntu Server 26.04 LTS 逐步部署

在一台已安裝 Ubuntu Server 26.04 LTS 的內網 VM 上，把 SafeTravel TW 架成署內鏡像站的完整步驟。運作原理、規格估算、日常維運與疑難排解見 [`MIRROR.md`](MIRROR.md)，這份只講「照著做」。

> 本文的指令以 `safetravel.cdc.internal` 當主機名稱、`10.20.0.0/16` 當 kiosk 網段、`10.10.5.0/24` 當管理網段，**都是範例，請換成實際值**。
> 標示「待現場確認」的地方，是撰寫時無法在 26.04 實機上驗證的項目。

---

## 0. 先跟資訊室申請的五件事

| 項目 | 內容 |
|---|---|
| 固定 IP 與 DNS 名稱 | 例如 `safetravel.cdc.internal` 指向這台 VM；kiosk 一律用名稱連線（憑證綁名稱） |
| 對外連線（防火牆） | 見[第 9 節](#9-防火牆申請清單)的表格 |
| TLS 憑證 | 由署內 CA 或機關使用的憑證機構簽發；第 5 節會產生申請檔（CSR） |
| 校時來源 | 署內 NTP 伺服器的位址（建議用署內的，不要對外） |
| 是否經由 proxy 上網 | 若是，需要 proxy 位址；若 proxy 會解開 TLS，還需要它的 CA 憑證 |

---

## 1. 作業系統基本設定

```bash
sudo timedatectl set-timezone Asia/Taipei        # 排程（自動更新、重開機時間）都依本機時區
sudo hostnamectl set-hostname safetravel
sudo apt update && sudo apt full-upgrade -y      # 先更新到最新，之後交給自動更新（第 8 節）
```

### 校時（chrony）

26.04 預設用 `chrony`。改成署內 NTP：

```bash
sudo tee /etc/chrony/sources.d/internal.sources >/dev/null <<'EOF'
server ntp.cdc.internal iburst
EOF
# 把預設的對外來源停用：/etc/chrony/chrony.conf 或 /etc/chrony/sources.d/ 裡以 pool / server 開頭、指向 ubuntu.com 的行，前面加 #
sudo systemctl restart chrony
chronyc sources -v        # 應只看到署內伺服器，且狀態為 ^*
```

預設來源的檔名「待現場確認」（`ls /etc/chrony/sources.d/`、`grep -n -E '^(pool|server)' /etc/chrony/chrony.conf`）。

### 主機防火牆（ufw）

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 10.10.5.0/24 to any port 22 proto tcp     # 管理網段才能 SSH
sudo ufw allow 443/tcp
sudo ufw allow 80/tcp                                          # 只用來轉址到 HTTPS
sudo ufw enable
sudo ufw status verbose
```

---

## 2. 安裝套件

```bash
sudo apt install -y nginx git curl rsync python3 openssl
nginx -v          # 26.04 為 1.28.x
git --version     # 2.53.x
```

`unattended-upgrades`、`chrony`、`ufw` 在 Server 版預設已安裝；沒有的話一併 `apt install`。

---

## 3. 經由 proxy 上網時（沒有 proxy 就跳過）

```bash
# apt
sudo tee /etc/apt/apt.conf.d/95proxy >/dev/null <<'EOF'
Acquire::http::Proxy  "http://proxy.cdc.internal:8080";
Acquire::https::Proxy "http://proxy.cdc.internal:8080";
EOF
# proxy 會解開 TLS 檢查時：把它的 CA 加入系統信任
sudo cp proxy-ca.crt /usr/local/share/ca-certificates/proxy-ca.crt && sudo update-ca-certificates
```

同步程式的 proxy 設在 `/etc/safetravel/mirror.env`（第 4 節安裝後才有這個檔）：

```
HTTPS_PROXY=http://proxy.cdc.internal:8080
NO_PROXY=localhost,127.0.0.1
```

---

## 4. 安裝鏡像同步程式

```bash
sudo git clone https://github.com/ancientsky/safetravel.git /opt/safetravel-src
#   經 proxy：sudo env https_proxy=http://proxy.cdc.internal:8080 git clone …
sudo bash /opt/safetravel-src/scripts/mirror/install.sh
```

`install.sh` 會建立 `safetravel` 帳號與 `/srv/safetravel/`、安裝同步程式與每 5 分鐘的排程、做第一次同步，並把 nginx 範本放到 `/etc/nginx/conf.d/safetravel.conf.disabled`（**不會自動啟用**）。偵測到 nginx 1.25.1 以上（26.04 是 1.28）時，範本會自動改用新寫法 `http2 on;`。

### 主機自我檢查（26.04 一定要跑一次）

```bash
sudo -u safetravel /opt/safetravel/safetravel-sync.sh --selftest
```

每一行都應是 `PASS`，最後顯示 `self-test passed`。它在暫存目錄裡檢查：必要工具、原子切換、硬連結、拒絕符號連結、舊版本清理、狀態檔與監控指令，以及**能不能連到 GitHub**（最後兩行 `network:`）。

- `network:` 兩行 `FAIL` → 防火牆或 proxy 還沒通，回到第 9 節。
- 其他行 `FAIL` → 請把整段輸出回報給網站維護者。

> 為什麼要這一步：Ubuntu 26.04 預設的 `coreutils` 改成 Rust 版（uutils），與過去的 GNU 版在少數行為上可能不同。同步程式已把關鍵步驟（原子切換、日期計算）改用 python3 執行，不依賴 coreutils 的版本；但撰寫時無法在 26.04 實機驗證，所以用這個檢查在你的 VM 上確認。

確認第一次同步成功：

```bash
/opt/safetravel/safetravel-sync.sh --check        # OK - SafeTravel mirror: synced … min ago …
ls -l /srv/safetravel/www/                        # safetravel -> ../releases/<版本>
systemctl list-timers safetravel-sync.timer       # 下次執行時間
```

---

## 5. TLS 憑證

kiosk 必須用 HTTPS：海報輪播防止螢幕休眠的功能只在安全連線下可用。

### 5.1 產生私鑰與憑證申請檔（CSR）

私鑰留在這台主機，**不要寄出去**；只把 `.csr` 交給資訊室。

```bash
sudo install -d -m 750 -o root -g root /etc/nginx/tls
cd /etc/nginx/tls
HOST=safetravel.cdc.internal
sudo openssl req -new -newkey rsa:2048 -nodes \
  -keyout safetravel.key -out safetravel.csr \
  -subj "/C=TW/O=衛生福利部疾病管制署/CN=$HOST" -utf8 \
  -addext "subjectAltName=DNS:$HOST"
sudo chmod 600 safetravel.key
sudo openssl req -in safetravel.csr -noout -verify -text | grep -E "verify|Subject:|DNS:"
```

- 現在的瀏覽器只看「主體別名」（SAN），不看 CN，所以 `-addext "subjectAltName=…"` 不能省；kiosk 若會用別的名稱或 IP 連線，一併寫進去（`DNS:a,DNS:b,IP:10.20.1.5`）。
- `-subj` 的機關名稱依憑證機構的要求填寫。
- RSA 2048 相容性最好；憑證機構接受時也可改用 ECDSA：`-newkey ec -pkeyopt ec_paramgen_curve:prime256v1`。

### 5.2 安裝簽回來的憑證

nginx 要的是「**伺服器憑證在前、中繼憑證在後**」合成的一個檔（不含根憑證）：

```bash
cd /etc/nginx/tls
sudo sh -c 'cat server.crt intermediate.crt > safetravel.crt'
sudo chmod 644 safetravel.crt
```

收到的格式不是 PEM（文字檔、`-----BEGIN CERTIFICATE-----` 開頭）時先轉換：

| 收到的檔案 | 轉成 PEM |
|---|---|
| `.cer`／`.der`（二進位） | `openssl x509 -inform der -in x.cer -out server.crt` |
| `.p7b`（憑證鏈） | `openssl pkcs7 -print_certs -in x.p7b -out chain.pem`（二進位加 `-inform der`） |
| `.pfx`／`.p12`（含私鑰） | `openssl pkcs12 -in x.pfx -nokeys -out server.crt`；`openssl pkcs12 -in x.pfx -nocerts -nodes -out safetravel.key` |

安裝前三項檢查：

```bash
# 1. 憑證與私鑰是一對（兩行輸出要相同）
openssl x509 -in safetravel.crt -noout -pubkey | sha256sum
sudo openssl pkey -in safetravel.key -pubout | sha256sum
# 2. 名稱與到期日
openssl x509 -in safetravel.crt -noout -subject -enddate -ext subjectAltName
# 3. 憑證鏈完整（root.crt 為憑證機構的根憑證）
openssl verify -CAfile root.crt -untrusted intermediate.crt server.crt
```

### 5.3 到期提醒

憑證到期後 kiosk 會全部出現憑證錯誤。請在行事曆記下到期日；主機上也可加一個每週一早上的檢查，到期前 30 天起寫入系統日誌（查看：`journalctl -t safetravel-cert`）：

```bash
sudo tee /etc/systemd/system/safetravel-cert.service >/dev/null <<'EOF'
[Unit]
Description=SafeTravel mirror: warn when the TLS certificate expires within 30 days
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'openssl x509 -checkend 2592000 -noout -in /etc/nginx/tls/safetravel.crt >/dev/null || logger -p user.warning -t safetravel-cert "TLS certificate expires within 30 days"'
EOF
sudo tee /etc/systemd/system/safetravel-cert.timer >/dev/null <<'EOF'
[Unit]
Description=SafeTravel mirror: weekly TLS certificate expiry check
[Timer]
OnCalendar=Mon *-*-* 09:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now safetravel-cert.timer
```

換憑證：放新的 `safetravel.crt`（必要時連同新私鑰），`sudo nginx -t && sudo systemctl reload nginx`，不會中斷服務。

### 5.4 kiosk 要信任這張憑證

- 憑證由公開受信任的憑證機構簽發：kiosk 不必做任何事。
- 由**署內 CA** 簽發：每台 kiosk 要匯入署內根憑證。Linux 上的 Chrome 讀的是使用者的 NSS 資料庫（「待現場確認」，請先在一台 kiosk 上試）：

  ```bash
  sudo apt install -y libnss3-tools
  mkdir -p ~/.pki/nssdb
  certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "CDC Internal CA" -i cdc-root-ca.crt
  ```

  要用 kiosk 實際執行 Chrome 的那個帳號執行；匯入後重開 Chrome，網址列不應再有憑證警告。

---

## 6. 啟用 nginx 站台

```bash
sudo rm -f /etc/nginx/sites-enabled/default      # Ubuntu 的預設歡迎頁，會搶走用 IP 連線的請求
sudo vi /etc/nginx/conf.d/safetravel.conf.disabled
```

要改的只有標 `←` 的行：

| 行 | 改成 |
|---|---|
| `server_name safetravel.example.internal;`（兩處） | 實際主機名稱 |
| `ssl_certificate` / `ssl_certificate_key` | 第 5 節的路徑相同就不用改 |
| `listen [::]:80;`、`listen [::]:443 ssl;` | 主機停用 IPv6 時刪除 |
| `# allow 10.0.0.0/8;` `# deny all;`（狀態頁） | 想限制誰能看同步狀態時，去掉 `#` 並改成維運網段 |

26.04 上，443 那段應該是（`install.sh` 已自動改好）：

```nginx
    listen 443 ssl;
    http2 on;
    listen [::]:443 ssl;
```

啟用：

```bash
sudo mv /etc/nginx/conf.d/safetravel.conf.disabled /etc/nginx/conf.d/safetravel.conf
sudo nginx -t                    # 不應有 warn；出現「listen … http2 is deprecated」表示還是舊寫法
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

範本做了什麼（完整說明在 `MIRROR.md` 第 4 節）：80 轉 443；`/safetravel/` 子路徑與 GitHub Pages 相同；文字檔 `no-cache`（未變動只回 304）、圖片快取 1 小時；gzip；`nosniff`、`Referrer-Policy`、禁止被其他網站內嵌；隱藏檔 403；TLS 只開 1.2 與 1.3；`/safetravel/_mirror/status.json` 提供同步狀態。**不要**加 `open_file_cache`，也不要在標頭的 CSP 加 `script-src` 之類的項目。

所有 kiosk 都確定只用 HTTPS 之後，可在 `location /safetravel/ { … }` 內取消這行的註解：

```nginx
        add_header Strict-Transport-Security "max-age=31536000" always;
```

---

## 7. 驗證

在 VM 上（`-k` 只是略過本機對憑證的信任檢查）：

```bash
H=safetravel.cdc.internal
curl -skI https://$H/safetravel/ | head -n 1                                  # HTTP/2 200
curl -sI  http://$H/safetravel/  | grep -i -E "^HTTP|^location"               # 301 → https
curl -skI https://$H/safetravel/ | grep -i -E "frame|content-security|nosniff"
curl -sk  https://$H/safetravel/_mirror/status.json                           # "result": "ok"
curl -skI https://$H/safetravel/.gitignore | head -n 1                        # 403
curl -sk -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}\n' https://$H/safetravel/data/epidemics.json   # 約 30 萬位元組（未壓縮約 130 萬）
echo | openssl s_client -connect $H:443 -servername $H 2>/dev/null | grep -E "Verify return code|Protocol"
```

在一台 kiosk 上：開 `https://safetravel.cdc.internal/safetravel/`，沒有憑證警告、地圖與入境航班看板正常、按 F12 的主控台沒有紅色錯誤。

---

## 8. 自動安裝系統更新

Ubuntu Server 內建 `unattended-upgrades`。以下設定：每天凌晨下載並安裝更新，需要重開機時在 03:45 自動重開。

```bash
sudo apt install -y unattended-upgrades needrestart
```

`/etc/apt/apt.conf.d/20auto-upgrades`（每天更新套件清單、下載、安裝，每 7 天清一次快取）：

```bash
sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
```

`/etc/apt/apt.conf.d/52safetravel-upgrades`（自己的設定放在獨立檔案，系統升級時不會被覆蓋）：

```bash
sudo tee /etc/apt/apt.conf.d/52safetravel-upgrades >/dev/null <<'EOF'
// 預設只裝安全性更新；加上這行，一般更新（-updates）也自動安裝
Unattended-Upgrade::Allowed-Origins:: "${distro_id}:${distro_codename}-updates";

Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";

// 需要重開機（核心、glibc 等）時，在凌晨自動重開；有人登入也照常重開
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:45";

Unattended-Upgrade::SyslogEnable "true";
EOF
```

把執行時間固定在凌晨（預設是早上 6 點與下午 6 點前後的隨機時間）：

```bash
sudo systemctl edit apt-daily.timer             # 下載
```
```ini
[Timer]
OnCalendar=
OnCalendar=*-*-* 02:00
RandomizedDelaySec=30m
```
```bash
sudo systemctl edit apt-daily-upgrade.timer     # 安裝
```
```ini
[Timer]
OnCalendar=
OnCalendar=*-*-* 03:00
RandomizedDelaySec=15m
```
```bash
sudo systemctl restart apt-daily.timer apt-daily-upgrade.timer
systemctl list-timers 'apt-daily*'
```

檢查：

```bash
sudo unattended-upgrade --dry-run --debug 2>&1 | tail -n 20      # 試跑，不會真的安裝
apt-config dump | grep -E "Periodic|Unattended-Upgrade::(Allowed|Automatic)"
ls /var/log/unattended-upgrades/                                  # 之後每天的紀錄
cat /var/run/reboot-required 2>/dev/null                          # 有這個檔＝等待重開機
```

說明：

- **只想自動裝安全性更新**：刪掉 `Allowed-Origins::` 那一行。
- **不想自動重開機**：把 `Automatic-Reboot` 設成 `"false"`，改為定期人工檢查 `/var/run/reboot-required`。不重開機，核心的安全性更新不會生效。
- **重開機的影響**：約 1 分鐘。kiosk 上已開啟的頁面照常顯示，這段時間的背景更新會失敗並自動重試；凌晨 03:45 幾乎沒有人使用。
- **nginx 更新後**：服務會自動重新啟動（`needrestart`），設定檔不會被改。
- **大版本升級**（26.04 → 28.04）不會自動進行，要人工執行 `do-release-upgrade`。
- **鏡像同步程式本身**不在 apt 裡，更新方式：`cd /opt/safetravel-src && sudo git pull && sudo bash scripts/mirror/install.sh`（網站內容每 5 分鐘自動同步，與這個無關）。

---

## 9. 防火牆申請清單

### 這台 VM 對外（來源：鏡像站 VM 的 IP）

| 用途 | 目的（網域名稱） | 連接埠 | 必要性 |
|---|---|---|---|
| 同步網站程式與資料（git） | `github.com` | TCP 443 | **必要** |
| 下載入境航班檔 `arrivals.json` | `ancientsky.github.io` | TCP 443 | **必要** |
| 系統更新 | `archive.ubuntu.com`、`security.ubuntu.com`（安裝時若選臺灣鏡像則另有 `tw.archive.ubuntu.com`） | TCP 80（預設）或 443 | 自動更新需要；署內若有 apt 鏡像或 proxy 則改連署內 |
| 校時 | 署內 NTP 伺服器 | UDP 123 | **必要**（建議用署內） |
| 名稱解析 | 署內 DNS 伺服器 | UDP／TCP 53 | **必要**（要能解析上面的網域名稱） |
| Ubuntu Pro／ESM（有訂閱才需要） | `esm.ubuntu.com`、`contracts.canonical.com` | TCP 443 | 選用 |

不需要開放：疾管署、外交部、TDX、氣象署等資料來源（這台主機從不連過去），以及任何由外向內的連線。

確認 apt 實際連哪些主機：`grep -h URIs /etc/apt/sources.list.d/*.sources`。資訊室要求只開 443 時，可把該檔的 `http://` 改成 `https://` 後 `sudo apt update` 驗證。

### 進入這台 VM

| 來源 | 連接埠 | 用途 |
|---|---|---|
| kiosk／牆面螢幕網段 | TCP 443、TCP 80 | 網站（80 只做轉址） |
| 管理網段 | TCP 22 | SSH 管理 |
| 監控主機（若有） | TCP 443 | 讀取 `/safetravel/_mirror/status.json` |

### 防火牆只能填 IP 時

GitHub 的 IP 會變動，官方做法是公布一份隨時更新的清單，**請優先申請用網域名稱（FQDN）放行，或改走署內 proxy**。只能填 IP 時：

1. 在任何一台能上網的電腦用瀏覽器開 `https://api.github.com/meta`，取其中三段：`web`、`git`（對應 `github.com`）與 `pages`（對應 `ancientsky.github.io`）。只需要 IPv4（沒有冒號的那些）。
2. 或在能上網的 Linux／macOS 執行：

   ```bash
   curl -fsS https://api.github.com/meta | python3 -c '
   import json, sys
   d = json.load(sys.stdin)
   for k in ("web", "git", "pages"):
       print(k + ":", *sorted({c for c in d[k] if ":" not in c}), sep="\n  ")'
   ```

3. Ubuntu 套件庫：`nslookup archive.ubuntu.com`、`nslookup security.ubuntu.com` 列出的位址。

撰寫本文時無法即時取得該清單。GitHub 長期使用的網段有 `140.82.112.0/20`、`143.55.64.0/20`、`192.30.252.0/22`（`github.com`）與 `185.199.108.0/22`（GitHub Pages），另外 `github.com` 在各地區還有架在 Azure 上的單一位址（`20.x.x.x/32`，從臺灣連線通常會解析到其中之一）——**這些僅供對照，申請時請以上述清單的實際內容為準**，並請資訊室每半年核對一次。

IP 清單過期時的表現：同步失敗，鏡像站繼續提供最後一個版本，`--check` 在 30 分鐘後轉為 WARNING、120 分鐘後 CRITICAL；`--selftest` 的 `network:` 兩行會指出是哪一個目的地不通。

---

## 10. kiosk 與監控

- kiosk 網址把 `https://ancientsky.github.io/safetravel/` 換成 `https://safetravel.cdc.internal/safetravel/`，後面的參數完全相同（例如 `?osk=1&reset=0&text=xl&arr=TPE-ABCD&win=60&full=1&layer=cdc&wx=1&lang=zh`）。
- kiosk 的 Chrome 網址白名單（`scripts/kiosk/install-policy.sh`）要加上署內主機：`sudo bash install-policy.sh safetravel.cdc.internal`。
- 國家面板的 QR code（`?qr=1`）一律指向公開網站，旅客的手機連不到內網，這是刻意的。
- 監控：`/opt/safetravel/safetravel-sync.sh --check`（結束碼 0／1／2），或讀 `https://safetravel.cdc.internal/safetravel/_mirror/status.json`。

---

## 11. 26.04 與舊版 Ubuntu 的差異（已處理）

| 差異 | 影響 | 處理 |
|---|---|---|
| nginx 1.28：`listen … http2` 已淘汰 | `nginx -t` 出現警告 | `install.sh` 自動改成 `http2 on;` |
| `coreutils` 預設為 Rust 版（uutils） | `mv -T`、`date -d` 等行為可能不同 | 同步程式改用 python3 做原子切換與日期計算；`--selftest` 在實機確認 |
| `sudo` 預設為 Rust 版（sudo-rs） | 指令列上直接寫 `VAR=值` 可能不被接受 | 文件裡的指令改用 `sudo env VAR=值 指令` |
| 校時改用 `chrony` | 設定檔位置不同於 `systemd-timesyncd` | 見第 1 節 |
| python3 為 3.14、git 為 2.53 | 無 | 同步程式需要 python 3.7 以上、git 2.27 以上 |

---

## English summary

Step-by-step deployment of the intranet mirror on Ubuntu Server 26.04 LTS: base OS settings (time zone, chrony pointed at the internal NTP server, ufw), packages, optional outbound proxy, `install.sh`, a host self-test (`safetravel-sync.sh --selftest`: tools, atomic switch, hard links, symlink refusal, pruning, status file, and reachability of GitHub), TLS (key + CSR with a SAN, converting and chaining what the CA returns, three pre-install checks, an expiry reminder, trusting an internal CA on kiosks), enabling the nginx site (`http2 on;` on nginx 1.25.1+, written by the installer), verification commands, `unattended-upgrades` (security and regular updates nightly, automatic reboot at 03:45, timers pinned to the small hours) and the firewall request: outbound TCP 443 to `github.com` and `ancientsky.github.io`, the Ubuntu archive, internal NTP and DNS; inbound 443/80 from kiosks and 22 from the management network. GitHub's addresses change — allow by name or through a proxy where possible, otherwise take the `web`, `git` and `pages` ranges from `https://api.github.com/meta`. Items that could not be verified on a real 26.04 host when this was written are marked 待現場確認.
