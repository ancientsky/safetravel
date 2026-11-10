# 展示機（kiosk）設定

給放在公共空間、民眾可以觸碰的螢幕（例如用 `cage` 只跑一個 Google Chrome／Chromium 視窗的機器）。目標：螢幕永遠留在 SafeTravel 網站上，
被玩亂了能自己復原。

## 1. 開機網址

```
https://ancientsky.github.io/safetravel/?osk=1&reset=5&arr=TPE-ABCD&wx=1&text=m&months=6&full=1
```

| 參數 | 作用 |
|---|---|
| `osk=1` | 螢幕小鍵盤（預設英數，可切注音）＋左下角 **↻ 重設畫面**（按兩下回到開機網址與設定） |
| `reset=5` | 有人用過之後閒置 5 分鐘自動重設（重設前 10 秒有提示，碰一下取消） |
| 其他 | 見 README「網址參數」或 [使用說明](../web/help.html) |

兩個參數在同一個瀏覽器工作階段內一直有效，切到出國前查詢、使用說明、衛教海報等頁面也一樣。

## 2. 第一層：網頁自己擋（不用設定）

只要網址帶 `osk=1` 或 `reset=`，網站就進入展示機模式（`web/js/osk.js`）：

- **外部網站連結**（頁尾的資料來源、領務局原文、機場與醫院網站、Google 地圖、Google 日曆…）、`tel:`／`mailto:` 連結：不跳轉，
  畫面下方顯示 4 秒「展示機無法開啟外部網站（網址）」，民眾可以用自己的手機查。
- **下載與列印**（CSV 匯出、行事曆 .ics、列印按鈕）：不執行，顯示「展示機無法下載或列印」。
- **站內連結**一律在同一個分頁開啟（不會多出一個重設不到的分頁）。
- 使用說明、衛教海報、瘧疾試算頁也有 ↻ 按鈕與閒置重設。

一般電腦與手機（網址沒有這兩個參數）完全不受影響。

## 3. 第二層：Google Chrome／Chromium 網址白名單（建議安裝）

網頁層的保護靠的是網頁程式本身；瀏覽器政策則由瀏覽器強制執行，就算網頁程式出錯、或有人接了鍵盤想輸入網址也一樣擋得住。

```bash
# 在 kiosk 上，以 root 執行（檔案在本 repo 的 scripts/kiosk/）
sudo bash install-policy.sh                        # 只允許 https://ancientsky.github.io/safetravel
sudo bash install-policy.sh safetravel.cdc.local   # 另外允許內網鏡像主機（可寫多個）
sudo bash install-policy.sh --remove               # 移除
```

它會在 `/etc/chromium/policies/managed/`、`/etc/chromium-browser/policies/managed/`、`/etc/opt/chrome/policies/managed/`
各寫一個 `safetravel-kiosk.json`，內容三者相同。瀏覽器只讀自己的那個資料夾，多寫的不影響：

| 瀏覽器 | 讀取的資料夾 |
|---|---|
| **Google Chrome**（`google-chrome`／`google-chrome-stable`） | `/etc/opt/chrome/policies/managed/` |
| Chromium（Debian、Raspberry Pi OS 的 `chromium`） | `/etc/chromium/policies/managed/` |
| Chromium（Ubuntu 的 `chromium-browser`、snap 版） | `/etc/chromium-browser/policies/managed/` |

政策內容：

| 政策 | 值 | 作用 |
|---|---|---|
| `URLBlocklist` | `["*"]` | 預設封鎖所有網址（含 `file://`、`chrome://settings`） |
| `URLAllowlist` | `ancientsky.github.io/safetravel`、`chrome://policy`、你加的主機 | 只放行本站；`chrome://policy` 留著給管理者確認設定 |
| `DownloadRestrictions` | `3` | 禁止所有下載 |
| `PrintingEnabled` | `false` | 禁止列印 |
| `DeveloperToolsAvailability` | `2` | 關閉開發人員工具 |
| `DefaultPopupsSetting`／`DefaultGeolocationSetting`／`DefaultNotificationsSetting` | `2` | 不開彈出視窗、不問定位與通知 |
| `TranslateEnabled`、`PasswordManagerEnabled`、`Autofill…`、`BrowserSignin`、`SyncDisabled`、書籤、預設瀏覽器詢問、使用統計 | 關閉 | 不跳出與展示無關的提示 |

**寫進自己的安裝腳本**（不想另外複製檔案時，貼這一段即可；要加內網主機就在 `URLAllowlist` 多寫一個字串）：

```bash
for d in /etc/chromium/policies/managed /etc/chromium-browser/policies/managed /etc/opt/chrome/policies/managed; do
  install -d -m 755 "$d"
  cat > "$d/safetravel-kiosk.json" <<'JSON'
{
  "URLBlocklist": ["*"],
  "URLAllowlist": ["ancientsky.github.io/safetravel", "chrome://policy"],
  "DownloadRestrictions": 3,
  "PrintingEnabled": false,
  "DeveloperToolsAvailability": 2,
  "DefaultPopupsSetting": 2,
  "DefaultGeolocationSetting": 2,
  "DefaultNotificationsSetting": 2,
  "TranslateEnabled": false,
  "PasswordManagerEnabled": false,
  "AutofillAddressEnabled": false,
  "AutofillCreditCardEnabled": false,
  "BrowserSignin": 0,
  "SyncDisabled": true,
  "BookmarkBarEnabled": false,
  "EditBookmarksEnabled": false,
  "DefaultBrowserSettingEnabled": false,
  "MetricsReportingEnabled": false
}
JSON
  chmod 644 "$d/safetravel-kiosk.json"
done
```

**安裝後請在一台機器上確認**（政策在瀏覽器啟動時讀取，裝完要重開瀏覽器或重開機）：

1. 開機網址正常顯示地圖，搜尋、國家面板、入境看板、出國前查詢頁都能用。
2. 接上鍵盤，在網址列輸入 `chrome://policy`：應列出上表的政策，狀態為「OK／確定」。
3. 輸入 `https://www.google.com`：應顯示「已遭封鎖／blocked by your organization」。
4. 若地圖頁本身被擋（白畫面或封鎖訊息），多半是開機網址的主機不在白名單（例如用了內網鏡像）：把主機名稱加到指令後面重裝，
   或先 `--remove` 還原。

> 這份政策的格式與每個政策名稱都依 Chromium 官方政策清單撰寫，安裝腳本也在測試環境執行過；但測試環境無法操作一個被政策鎖定的
> 瀏覽器，所以**實際封鎖效果請以上面四步在實機確認**。先裝一台，沒問題再套用到其他機器。

## 4. 建議的啟動參數（cage）

Google Chrome 與 Chromium 的參數相同，只有指令名稱不同（Chrome 是 `google-chrome` 或 `google-chrome-stable`）：

```bash
cage -- google-chrome --kiosk --no-first-run --noerrdialogs --disable-infobars \
  --disable-session-crashed-bubble --disable-pinch --overscroll-history-navigation=0 \
  'https://ancientsky.github.io/safetravel/?osk=1&reset=5&arr=TPE-ABCD&wx=1&text=m&full=1'
```

`--kiosk` 沒有網址列與分頁列；`--disable-pinch` 與 `--overscroll-history-navigation=0` 避免民眾用手勢縮放整頁或滑動回上一頁。
