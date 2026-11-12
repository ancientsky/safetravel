# 署內鏡像站：Ubuntu Server 26.04 LTS 逐步部署

在一台已安裝 Ubuntu Server 26.04 LTS 的內網 VM 上，把 SafeTravel TW 架成署內鏡像站的完整步驟。運作原理、規格估算、日常維運與疑難排解見 [`MIRROR.md`](MIRROR.md)，這份只講「照著做」。

> 本文的指令以 `safetravel.cdc.internal` 當主機名稱、`10.20.0.0/16` 當 kiosk 網段、`10.10.5.0/24` 當管理網段，**都是範例，請換成實際值**。
> 標示「待現場確認」的地方，是撰寫時無法在 26.04 實機上驗證的項目。

---

## 0. 先跟資訊室申請的五件事

| 項目 | 內容 |
|---|---|
| 固定 IP 與 DNS 名稱 | 例如 `safetravel.cdc.internal` 指向這台 VM；kiosk 一律用名稱連線（憑證綁名稱）。使用機關的萬用字元憑證時，名稱必須在該網域下一層，例如 `safetravel.cdc.gov.tw` |
| 對外連線（防火牆） | 見[第 9 節](#9-防火牆申請清單)的表格 |
| TLS 憑證 | 機關已有萬用字元憑證（如 `*.cdc.gov.tw`）時直接取得憑證檔（第 5.0 節）；否則由署內 CA 或機關使用的憑證機構簽發，第 5.1 節會產生申請檔（CSR） |
| 校時來源 | 署內 NTP 伺服器的位址（建議用署內的，不要對外） |
| 是否經由 proxy 上網 | 若是，需要 proxy 位址；若 proxy 會解開 TLS，還需要它的 CA 憑證 |

---

## 1. 作業系統基本設定

```bash
sudo timedatectl set-timezone Asia/Taipei        # 排程（自動更新、重開機時間）都依本機時區
sudo hostnamectl set-hostname safetravel
sudo apt update && sudo apt full-upgrade -y      # 先更新到最新，之後交給自動更新（第 8 節）
```

### 系統更新來源改用臺灣鏡像站

26.04 的套件來源寫在 `/etc/apt/sources.list.d/ubuntu.sources`（舊版 Ubuntu 是 `/etc/apt/sources.list`）。兩種做法擇一。

#### 做法一：全部指向同一個臺灣鏡像站（防火牆只需開一個更新來源）

以 root 執行（`sudo -i` 之後貼上，或放進自己的安裝腳本）。`APT_MIRROR` 可在執行前指定別的鏡像站；設成空字串則不改來源、只做更新。

```bash
APT_MIRROR="${APT_MIRROR:-https://free.nchc.org.tw/ubuntu/}"
# 所有 Ubuntu 套件來源（含 security）統一指向台灣鏡像站 → 防火牆只需開一個更新來源
if [[ -n "$APT_MIRROR" ]]; then
  if [[ -f /etc/apt/sources.list.d/ubuntu.sources ]]; then
    [[ -f /etc/apt/sources.list.d/ubuntu.sources.orig ]] || cp /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources.orig
    sed -i -E "s|^URIs:.*|URIs: ${APT_MIRROR}|" /etc/apt/sources.list.d/ubuntu.sources
  elif [[ -f /etc/apt/sources.list ]]; then
    [[ -f /etc/apt/sources.list.orig ]] || cp /etc/apt/sources.list /etc/apt/sources.list.orig
    sed -i -E "s#https?://[^ ]*(archive|security)\.ubuntu\.com/ubuntu/?#${APT_MIRROR}#g" /etc/apt/sources.list
  fi
fi
apt-get update
apt-get -y full-upgrade
```

這段做的事：

- 第一次執行時把原檔備份成 `.orig`（之後重跑不會蓋掉備份）；apt 會自動略過 `.orig` 檔，放在同一個資料夾沒有問題。
- 新格式（`ubuntu.sources`）：把每一行 `URIs:` 都換成鏡像站，包含 `resolute-security` 那一段；以 `#` 開頭的註解行不動。
- 舊格式（`sources.list`）：只換 `archive.ubuntu.com`、`security.ubuntu.com`（含 `tw.archive…` 這類國別入口），PPA 等第三方來源不動。
- 可重複執行；換鏡像站就改 `APT_MIRROR` 再跑一次。還原：把 `.orig` 複製回原檔名後 `apt-get update`。

確認：

```bash
grep -n '^URIs' /etc/apt/sources.list.d/ubuntu.sources      # 兩行都是鏡像站
apt-get update 2>&1 | grep -c -i 'ubuntu\.com'              # 應為 0：已不再連 ubuntu.com
apt-cache policy | grep -m1 resolute-security               # 安全性更新也來自鏡像站
```

要知道的三件事：

- **安全性更新會晚一點**：鏡像站定期向主站同步，修補發布後要等下一次同步才拿得到（通常幾小時內）。Ubuntu 預設讓安全性更新直接連 `security.ubuntu.com` 就是為了避開這段延遲；這裡用它換「防火牆少開一個目的地」。
- **走 HTTPS，防火牆只開 TCP 443**：`free.nchc.org.tw`（國家高速網路與計算中心）在 Ubuntu 官方鏡像清單上只列 HTTP，但實測 `https://free.nchc.org.tw/ubuntu/` 可以連，所以預設值用 `https://`，不需要開 80。HTTPS 若日後失效（憑證過期等），`apt-get update` 會報憑證錯誤；屆時改用 `APT_MIRROR=https://tw.archive.ubuntu.com/ubuntu/`，或暫時改回 `http://` 並加開 TCP 80（套件有簽章驗證，走 HTTP 也不會被竄改）。
- **鏡像站停擺時**更新會失敗（網站本身不受影響）；`/var/log/unattended-upgrades/` 會有錯誤紀錄，把 `APT_MIRROR` 換成另一個站重跑即可。

撰寫時這段指令在兩種格式的範例檔上測過（替換結果、註解行、第三方來源、重複執行）；`free.nchc.org.tw` 無法從撰寫環境連線，HTTPS 可用是站台維護者在現場確認的。請在 VM 上確認 `apt-get update` 成功，且輸出裡每一行來源都是 `https://free.nchc.org.tw`。

#### 做法二：主要套件庫用臺灣鏡像站，安全性更新維持官方主站

```bash
sudo cp /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list.d/ubuntu.sources.orig
sudo sed -i -E 's#https?://([a-z]{2}\.)?archive\.ubuntu\.com/ubuntu/?#https://tw.archive.ubuntu.com/ubuntu/#' \
  /etc/apt/sources.list.d/ubuntu.sources
grep -n '^URIs' /etc/apt/sources.list.d/ubuntu.sources
sudo apt update
```

改完應該是：

```
URIs: https://tw.archive.ubuntu.com/ubuntu/      ← resolute、resolute-updates、resolute-backports
URIs: http://security.ubuntu.com/ubuntu/         ← resolute-security（不動）
```

安全性更新一發布就拿得到，但防火牆要開兩個目的地。撰寫時查證：`tw.archive.ubuntu.com`（Ubuntu 官方的臺灣入口）有 26.04（resolute）、更新時間與主站相同、HTTP 與 HTTPS 都可連。

#### 臺灣的鏡像站

Ubuntu 官方鏡像清單 <https://launchpad.net/ubuntu/+archivemirrors> 列為「Up to date」者（撰寫時只實際連線測過第一個）：

| 鏡像站 | `APT_MIRROR` | 頻寬 | HTTPS |
|---|---|---|---|
| Ubuntu 官方臺灣入口 | `https://tw.archive.ubuntu.com/ubuntu/` | — | 有 |
| Taiwan Digital Streaming | `https://mirror.twds.com.tw/ubuntu/` | 100 Gbps | 有 |
| 國家高速網路與計算中心（NCHC） | `https://free.nchc.org.tw/ubuntu/` | 20 Gbps | 有（官方清單只列 HTTP，現場實測可連） |
| Ubuntu-TW | `https://ftp.ubuntu-tw.net/ubuntu/` | 4 Gbps | 有 |

自動更新（第 8 節）依套件庫的名稱判斷，不看網址，換鏡像站不用改設定。防火牆放行單一主機時，選定一個站並寫進申請單（第 9 節）；之後換站要重新申請。

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

> 為什麼要這一步：Ubuntu 26.04 預設的 `coreutils` 改成 Rust 版（uutils），與過去的 GNU 版在少數行為上可能不同。同步程式已把關鍵步驟（原子切換、日期計算）改用 python3 執行，不依賴 coreutils 的版本，這個檢查用來在你的 VM 上確認。
>
> 2026-11-12 已在一台 Ubuntu 26.04 實機上全部 `PASS`（uutils coreutils 0.10.0、git 2.53.0、rsync 3.4.1、python 3.14.4）。
>
> 判斷只看每行開頭的 `PASS`／`FAIL` 與最後一行。舊版腳本從自己的家目錄執行時，中間會夾雜 `find: Failed to restore initial working directory … Permission denied` 與 `skipping non-regular file "link"`，那是工具的提示訊息、不是檢查失敗；更新同步程式後不再出現。

確認第一次同步成功：

```bash
/opt/safetravel/safetravel-sync.sh --check        # OK - SafeTravel mirror: synced … min ago …
ls -l /srv/safetravel/www/                        # safetravel -> ../releases/<版本>
systemctl list-timers safetravel-sync.timer       # 下次執行時間
```

---

## 5. TLS 憑證

kiosk 必須用 HTTPS：海報輪播防止螢幕休眠的功能只在安全連線下可用。

依手上有什麼選一條路：**已經拿到現成的憑證檔**（例如機關的萬用字元憑證 `*.cdc.gov.tw`）→ 5.0；**要自己申請** → 5.1、5.2。5.3、5.4 兩者都適用。

### 5.0 已經拿到憑證檔（fullchain.pem／privkey.pem）

拿到的是一整包時，nginx 只需要其中兩個檔：

| 檔案 | 內容 | 用途 |
|---|---|---|
| `fullchain.pem` | 伺服器憑證＋中繼憑證 | **nginx 的 `ssl_certificate`** |
| `privkey.pem` | 私鑰 | **nginx 的 `ssl_certificate_key`** |
| `cert.pem` | 只有伺服器憑證 | 檢查用 |
| `chain.pem` | 只有中繼憑證 | 檢查用 |
| `.pfx`、`.jks` | 同一組憑證與私鑰，Windows（IIS）與 Java 用的格式 | 不需要，**不要放到這台主機** |
| `cert.meta` | 憑證的附帶資訊（內容依簽發工具而定） | nginx 用不到 |

**主機名稱要配合憑證**：`*.cdc.gov.tw` 只涵蓋「一層」的名稱。`safetravel.cdc.gov.tw` 可以；`a.b.cdc.gov.tw`、`safetravel.cdc.internal`、直接用 IP 都不行（瀏覽器會出現憑證錯誤）。請資訊室在署內 DNS 加一筆記錄把選定的名稱指到這台 VM，kiosk 一律用這個名稱連線。

**1. 把檔案傳到 VM**（只傳四個 `.pem`；例如從自己的電腦 `scp cert.pem chain.pem fullchain.pem privkey.pem 帳號@VM:~/tls-in/`），然後在該資料夾裡檢查：

```bash
cd ~/tls-in && chmod 700 . && chmod 600 privkey.pem
H=safetravel.cdc.gov.tw                                             # 你選定的主機名稱

openssl x509 -in cert.pem -noout -subject -issuer -dates -ext subjectAltName   # 簽給誰、誰簽的、有效期、涵蓋的名稱
openssl x509 -in cert.pem -noout -checkhost "$H"                    # 應為 does match certificate
openssl x509 -in fullchain.pem -noout -pubkey | sha256sum           # ┐ 兩行輸出要相同：
openssl pkey -in privkey.pem -pubout | sha256sum                    # ┘ 憑證與私鑰是一對
head -n 1 privkey.pem                                               # 應為 -----BEGIN PRIVATE KEY-----
openssl crl2pkcs7 -nocrl -certfile fullchain.pem | openssl pkcs7 -print_certs -noout | grep subject
                                                                    # 第一行是 *.cdc.gov.tw，之後才是中繼憑證
openssl verify -untrusted chain.pem cert.pem                        # cert.pem: OK
```

- `head` 那行若是 `BEGIN ENCRYPTED PRIVATE KEY`，表示私鑰有密碼，nginx 開機時讀不了。請資訊室提供密碼後先解開：`openssl pkey -in privkey.pem -out privkey.pem`（會詢問密碼）。
- `openssl verify` 顯示 `OK`，表示這張憑證由 Ubuntu 內建信任的公開憑證機構簽發，kiosk 通常不必另外匯入根憑證（仍請在一台 kiosk 上實際開一次確認）。顯示 `unable to get local issuer certificate` 則是署內 CA 或少見的憑證機構：伺服器端照樣可以用，但 kiosk 要照 5.4 匯入根憑證。
- `notAfter` 就是到期日，請記到行事曆；並問清楚**到期前由誰提供新檔案**（見本節最後）。

**2. 安裝**（檔名改成 nginx 範本預設的名稱，之後不用改範本裡的路徑）：

```bash
sudo install -d -m 750 -o root -g root /etc/nginx/tls
sudo install -m 644 -o root -g root fullchain.pem /etc/nginx/tls/safetravel.crt
sudo install -m 600 -o root -g root privkey.pem   /etc/nginx/tls/safetravel.key
sudo ls -l /etc/nginx/tls/          # safetravel.crt 644 root、safetravel.key 600 root
```

**3. 清掉傳上來的副本**：

```bash
cd ~ && shred -u ~/tls-in/privkey.pem && rm -rf ~/tls-in
```

**4. 接著做第 6 節**（啟用 nginx 站台）：`server_name` 兩處填上面選定的名稱，憑證路徑不用改。完成後用**不加 `-k`** 的方式驗證，這樣才會真的檢查憑證與名稱：

```bash
H=safetravel.cdc.gov.tw
curl -sSI https://$H/safetravel/ | head -n 1                         # HTTP/2 200
#   署內 DNS 還沒加記錄時，先在 VM 上這樣測：
curl -sSI --resolve $H:443:127.0.0.1 https://$H/safetravel/ | head -n 1
echo | openssl s_client -connect 127.0.0.1:443 -servername $H 2>/dev/null | grep -E "^ *[0-9] s:|^ *Verify return code" | sort -u
#   應列出兩張憑證（0 是 *.cdc.gov.tw，1 是中繼憑證），Verify return code: 0 (ok)
```

憑證由署內 CA 簽發時，這台主機不認得根憑證：`curl` 要加 `--cacert 根憑證.crt`，`openssl s_client` 要加 `-CAfile 根憑證.crt`，否則會是 `Verify return code: 20` 或 `21`。這不影響 nginx，只表示 kiosk 需要照 5.4 匯入根憑證。

`curl` 出現 `SSL certificate problem` 或 `no alternative certificate subject name matches`，分別代表憑證鏈不被信任、或主機名稱不在憑證涵蓋範圍。

**一個指令做完檢查與安裝**：`install.sh` 會把 `safetravel-cert.sh` 裝到 `/opt/safetravel/`。它做的就是第 1、2 步的檢查與安裝，另外在 `nginx -t` 不通過時把原來的憑證放回去，並確認 nginx 真的換成新憑證：

```bash
sudo /opt/safetravel/safetravel-cert.sh ~/tls-in safetravel.cdc.gov.tw   # 資料夾裡要有 fullchain.pem 與 privkey.pem
sudo /opt/safetravel/safetravel-cert.sh --check                           # 之後隨時查看：名稱、到期日、nginx 是否正在使用
```

每行應為 `PASS`。`WARN` 是提醒（30 天內到期、nginx 站台還沒啟用等）；`FAIL` 表示沒有安裝，原來的憑證不受影響。主機名稱省略時取 nginx 站台設定裡的 `server_name`。第一次安裝時站台還沒啟用（第 6 節），啟用後再跑一次 `--check`。用了這個工具，第 2 步可以略過，第 3 步（清掉副本）仍然要做。

**萬用字元憑證的私鑰要特別保護**：同一把私鑰保護機關所有 `*.cdc.gov.tw` 的網站，外流的影響不只這台主機。

- 只放在 `/etc/nginx/tls/`，權限 `600 root`；`.pfx`、`.jks` 也含私鑰，不要帶到這台主機。
- 不要放進 git、不要貼到聊天或工單、不要用電子郵件寄；傳檔用 `scp`，傳完把自己電腦與 VM 上的暫存副本刪掉。
- 這台 VM 的 SSH 只開給管理網段（第 1 節的 ufw 規則），能 `sudo` 的帳號愈少愈好。

**到期與更換**：萬用字元憑證由資訊室統一換發，換發後每一台使用它的主機都要換檔，而且**會比以前頻繁**：

- `cert.pem`、`chain.pem`、`fullchain.pem`、`privkey.pem` 這組檔名是自動簽發工具（ACME／certbot）的慣例，這類憑證的效期通常只有幾個月。實際效期看第 1 步輸出的 `notBefore`、`notAfter`。
- 公開受信任的憑證，業界規定的效期上限逐年縮短：2026 年 3 月起 200 天、2027 年 3 月起 100 天、2029 年 3 月起 47 天。
- 請向資訊室問清楚三件事：**多久換發一次、新檔案怎麼交付、會不會事先通知**。

更換時把新的 `fullchain.pem`、`privkey.pem` 傳上來，執行 `safetravel-cert.sh`（或重做檢查與安裝兩步，再 `sudo nginx -t && sudo systemctl reload nginx`），不會中斷服務。上一組憑證留在 `/etc/nginx/tls/prev/`。5.3 的每週檢查會在到期前 30 天起寫入系統日誌。

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

換憑證：`sudo /opt/safetravel/safetravel-cert.sh <放新檔案的資料夾>`（見 5.0）；或手動放新的 `safetravel.crt`（必要時連同新私鑰），`sudo nginx -t && sudo systemctl reload nginx`。兩種做法都不會中斷服務。

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

啟用後檢查 nginx 實際載入的設定（`nginx -T` 會印出所有設定檔合併後的結果）：

```bash
sudo nginx -T 2>/dev/null | grep -n -E "^\s*(server_name|listen|ssl_certificate|ssl_certificate_key|http2)\b"
```

應該只有下面這幾行（行號與行尾的 `# ←` 註解不計）。多出別的 `listen` 或 `server_name`，表示還有其他站台設定檔（常見的是沒刪掉的 `sites-enabled/default`）：

```nginx
    listen 80;
    listen [::]:80;
    server_name safetravel.cdc.gov.tw;
    listen 443 ssl;
    http2 on;
    listen [::]:443 ssl;
    server_name safetravel.cdc.gov.tw;
    ssl_certificate     /etc/nginx/tls/safetravel.crt;
    ssl_certificate_key /etc/nginx/tls/safetravel.key;
```

再用 `sudo /opt/safetravel/safetravel-cert.sh --check` 確認 nginx 發出去的就是剛安裝的憑證。

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
| 系統更新 | 第 1 節做法一：只有 `free.nchc.org.tw`（或你選的那一個鏡像站）。做法二：`tw.archive.ubuntu.com` 與 `security.ubuntu.com`。都沒改：`archive.ubuntu.com` 與 `security.ubuntu.com` | 網址是 `https://` 的為 TCP 443（做法一預設即是）；`security.ubuntu.com` 預設為 TCP 80 | 自動更新需要；署內若有 apt 鏡像或 proxy 則改連署內 |
| 校時 | 署內 NTP 伺服器 | UDP 123 | **必要**（建議用署內） |
| 名稱解析 | 署內 DNS 伺服器 | UDP／TCP 53 | **必要**（要能解析上面的網域名稱） |
| Ubuntu Pro／ESM（有訂閱才需要） | `esm.ubuntu.com`、`contracts.canonical.com` | TCP 443 | 選用 |

不需要開放：疾管署、外交部、TDX、氣象署等資料來源（這台主機從不連過去），以及任何由外向內的連線。

確認 apt 實際連哪些主機：`grep -h '^URIs' /etc/apt/sources.list.d/*.sources`。資訊室要求只開 443 時，選用網址為 `https://` 的鏡像站（第 1 節的表格），改完 `sudo apt update` 驗證。

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

3. Ubuntu 套件庫：對 `grep -h '^URIs' /etc/apt/sources.list.d/ubuntu.sources` 列出的主機逐一 `nslookup`（例如 `nslookup free.nchc.org.tw`）。

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
| `coreutils` 預設為 Rust 版（uutils） | `mv -T`、`date -d` 等行為可能不同 | 同步程式改用 python3 做原子切換與日期計算；`--selftest` 已在 26.04 實機（uutils 0.10.0）全部通過 |
| `sudo` 預設為 Rust 版（sudo-rs） | 指令列上直接寫 `VAR=值` 可能不被接受 | 文件裡的指令改用 `sudo env VAR=值 指令` |
| 校時改用 `chrony` | 設定檔位置不同於 `systemd-timesyncd` | 見第 1 節 |
| python3 為 3.14、git 為 2.53 | 無 | 同步程式需要 python 3.7 以上、git 2.27 以上 |

---

## English summary

Step-by-step deployment of the intranet mirror on Ubuntu Server 26.04 LTS: base OS settings (time zone, chrony pointed at the internal NTP server, ufw), packages, optional outbound proxy, `install.sh`, a host self-test (`safetravel-sync.sh --selftest`: tools, atomic switch, hard links, symlink refusal, pruning, status file, and reachability of GitHub), TLS (key + CSR with a SAN, converting and chaining what the CA returns, three pre-install checks, an expiry reminder, trusting an internal CA on kiosks), enabling the nginx site (`http2 on;` on nginx 1.25.1+, written by the installer), verification commands, `unattended-upgrades` (security and regular updates nightly, automatic reboot at 03:45, timers pinned to the small hours) and the firewall request: outbound TCP 443 to `github.com` and `ancientsky.github.io`, the Ubuntu archive, internal NTP and DNS; inbound 443/80 from kiosks and 22 from the management network. GitHub's addresses change — allow by name or through a proxy where possible, otherwise take the `web`, `git` and `pages` ranges from `https://api.github.com/meta`. Items that could not be verified on a real 26.04 host when this was written are marked 待現場確認.
