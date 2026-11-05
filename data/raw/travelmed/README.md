# 旅遊醫學開放資料（疾管署，每月更新）

`od.cdc.gov.tw` 不回應 GitHub Actions 的連線，所以這三個檔案需要從臺灣的網路下載後，上傳到這個資料夾
（GitHub 網頁：這個資料夾 → Add file → Upload files），檔名保持原樣：

- TMClinicsList.csv — https://od.cdc.gov.tw/quarantine/TMClinicsList.csv
- ClinicsTime.csv — https://od.cdc.gov.tw/quarantine/ClinicsTime.csv
- TMPrescription.csv — https://od.cdc.gov.tw/quarantine/TMPrescription.csv

資料管線每次執行仍會先試著自動下載；連不上時沿用這裡現有的檔案。
