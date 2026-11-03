# 自動上架資料夾 · Auto-publish folder

把衛教海報圖檔（PNG / JPG / WebP）上傳到這個資料夾，就會自動加入 [slide.html](https://ancientsky.github.io/safetravel/slide.html) 的輪播；刪除檔案就下架。

上傳：本頁上方「Add file」→「Upload files」→ 拖入圖檔 →「Commit changes」。約 2–3 分鐘後網站更新，機場螢幕 5 分鐘內開始播放。

檔名可以加設定（用 `_` 或空格分隔）：

| 檔名裡的字 | 意思 |
|---|---|
| `01_`、`02_`（開頭數字） | 播放順序 |
| `上架2026-11-10` | 這天起才播放 |
| `下架2026-12-31` | 播到這天（含）為止 |
| `10秒` | 這張停留秒數（3–60） |
| `直式` / `橫式` | 同一張海報的直式版／橫式版 |
| `中文` / `英文` / `雙語` | 海報語言 |
| `加頁尾` | 加疾管署頁尾 |
| 開頭加 `_` | 暫停播放（不用刪檔） |

例：`01_猴痘宣導_下架2026-12-31_10秒.png`

`index.json` 是自動產生的，請勿手動編輯。完整說明：[docs/SLIDES.md](../../../docs/SLIDES.md)

Drop poster images here to publish them on slide.html; delete to retire. File-name settings: `from2026-11-10`, `until2026-12-31`, `10s`, `portrait`/`landscape`, `zh`/`en`/`bi`, `brand`; leading number = order; leading `_` = paused.
