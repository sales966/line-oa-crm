# LINE OA 客戶進度中樞 — 運維手冊(備份 / 開機自啟 / 還原)

本目錄 `scripts-ops/` 收錄伺服器維運用的純腳本,**不牽涉 `backend/src` 程式碼**,
可獨立執行。以下說明備份機制、如何設定 Windows 排程、以及災難還原步驟。

---

## 一、檔案總覽

| 檔案 | 位置 | 用途 |
| ---- | ---- | ---- |
| `backup.ps1` | `scripts-ops\backup.ps1` | 實際執行備份的 PowerShell 腳本 |
| `backup.bat` | 專案根目錄 `lineoa\backup.bat` | 備份入口,供雙擊或排程呼叫 `backup.ps1` |
| `setup-autostart.ps1` | `scripts-ops\setup-autostart.ps1` | 建立/移除兩個 Windows 排程 |
| `start.bat` | 專案根目錄 `lineoa\start.bat` | 啟動後端(埠 4680),排程 (a) 會呼叫它 |

---

## 二、備份內容與位置

備份會把下列兩個目錄複製到帶時間戳的資料夾:

- `backend\data\`  —— SQLite 主資料庫 `app.db`(客戶、訊息、檔案 metadata、稽核紀錄等)
- `backend\storage\` —— 使用者上傳的實體檔案(`storage\files`、`storage\tmp`)

輸出位置:

```
backend\backups\backup-YYYYMMDD-HHmmss\
    ├─ data\        (app.db 一致性快照,或整個 data 夾的複本)
    └─ storage\     (files / tmp 完整複本)
```

執行紀錄寫在 `backend\backups\backup.log`。

### SQLite 熱備份說明
`backup.ps1` 會**優先**使用後端既有的 `better-sqlite3` 套件執行線上 `.backup()`,
即使後端正在運行、資料庫正在寫入,也能取得**單一致性**的 `app.db` 快照,
避免直接複製 `.db + .db-wal` 時可能發生的資料撕裂。

若當下 `node` 或 `better-sqlite3` 不可用,會自動**退回**以 `robocopy` 複製整個
`data` 夾(含 `.db` / `.db-wal` / `.db-shm`);還原時 SQLite 會自行重放 WAL,
仍可得到完整資料。

### 保留策略
只保留**最近 14 份**備份,更舊的自動刪除(於每次備份結束時套用)。

---

## 三、設定 Windows 排程(開機自啟 + 每日備份)

> 必須以「**系統管理員身分**」開啟 PowerShell。
> (開始功能表 → 搜尋 `PowerShell` → 右鍵「以系統管理員身分執行」)

進入專案根目錄後執行:

```powershell
cd C:\Users\tomor\Desktop\lineoa
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts-ops\setup-autostart.ps1"
```

會建立兩個排程:

| 排程名稱 | 觸發 | 動作 |
| -------- | ---- | ---- |
| `LineOA-Backend-Autostart` | 開機時 (AtStartup) | 執行 `start.bat` 啟動後端 |
| `LineOA-Daily-Backup` | 每天 02:00(錯過會於開機/喚醒後補跑) | 執行 `backup.bat` 進行備份 |

> 每日備份排程以 `Register-ScheduledTask` 建立,並啟用
> `StartWhenAvailable` + `WakeToRun`:這台是工作站,凌晨 02:00 多半關機或
> 睡眠,若沿用純 schtasks 的 DAILY 排程,錯過的備份**不會補跑也不會告警**;
> 啟用後,錯過的 02:00 備份會在下次開機/喚醒後盡快補跑。

兩者皆以 `SYSTEM` 身分執行,**免密碼、免登入**即可運作。

### 驗證排程
```powershell
schtasks /Query /TN "LineOA-Backend-Autostart" /V /FO LIST
schtasks /Query /TN "LineOA-Daily-Backup"      /V /FO LIST
```

### 立即測試備份(不必等到 02:00)
```powershell
schtasks /Run /TN "LineOA-Daily-Backup"
```
執行後檢查 `backend\backups\` 是否出現新的 `backup-...` 夾,並看 `backup.log`。

### 移除排程
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts-ops\setup-autostart.ps1" -Remove
```

### 進階:改為「登入時」才啟動後端
若不希望開機即啟(例如希望登入桌面後才啟動),
可編輯 `setup-autostart.ps1`,將 `$AutostartTrigger = 'AtStartup'`
改為 `'AtLogon'`,再重新執行一次建立指令。

---

## 四、手動執行一次備份

不透過排程,亦可隨時手動備份:

- 直接**雙擊**專案根目錄的 `backup.bat`,或
- 在 PowerShell 執行:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\tomor\Desktop\lineoa\scripts-ops\backup.ps1"
  ```

---

## 五、災難還原(Restore)

> **還原前務必先停止後端**,以免覆蓋當下正在使用的資料庫。

1. **停止後端**
   - 若是排程啟動:
     ```powershell
     schtasks /End /TN "LineOA-Backend-Autostart"
     ```
   - 或直接關閉執行後端的視窗 / 結束對應的 `node` 程序。

2. **選擇要還原的備份**
   在 `backend\backups\` 找到目標時間戳資料夾,例如
   `backup-20260708-020000\`。

3. **還原資料庫與檔案**
   - 先把現有(可能損毀的)資料另存一份以防萬一:
     將 `backend\data` 與 `backend\storage` 改名為 `data.bak` / `storage.bak`。
   - 將備份夾內的 `data\` 與 `storage\` **複製回** `backend\` 之下。
     **務必用 `robocopy`(而非 `Copy-Item -Recurse`)還原 `storage`**:
     `storage\files` 下是 `{chatId}\{contentHash}_{fileName}`,路徑常超過
     Windows MAX_PATH(260),`Copy-Item -Recurse` 會在這些長路徑檔案上失敗、
     導致還原不完整卻不易察覺(這正是備份端一律用 robocopy 的原因,還原端
     必須一致)。`data` 為求前後一致也用 robocopy:
     ```powershell
     $bk = "C:\Users\tomor\Desktop\lineoa\backend\backups\backup-YYYYMMDD-HHmmss"
     robocopy "$bk\data"    "C:\Users\tomor\Desktop\lineoa\backend\data"    /E /R:1 /W:1
     robocopy "$bk\storage" "C:\Users\tomor\Desktop\lineoa\backend\storage" /E /R:1 /W:1
     ```
     (robocopy 原生支援長路徑;結束碼 < 8 皆為成功,8 以上才是錯誤。)
   - 確認 `backend\data\app.db` 已就位。

4. **(僅退回方案的備份需注意)**
   若該備份是以 robocopy 複製的整個 data 夾,可能含 `.db-wal` / `.db-shm`;
   一併複製回去即可,SQLite 啟動時會自動重放 WAL,無需手動處理。
   若是線上 `.backup()` 產生的備份,`data\` 只有單一 `app.db`,直接使用即可。

5. **重新啟動後端**
   - 雙擊 `start.bat`,或重新啟用排程:
     ```powershell
     schtasks /Run /TN "LineOA-Backend-Autostart"
     ```
   - 開啟 WebUI 確認客戶、訊息、檔案、稽核紀錄皆正常。

---

## 六、常見問題

- **排程沒有觸發?**
  用 `schtasks /Query /TN "..." /V /FO LIST` 查 `Last Result`;
  `0x0` 代表成功。確認建立時是以系統管理員身分執行。

- **備份夾一直沒增加?**
  查看 `backend\backups\backup.log` 是否有錯誤訊息;確認 `backend\data`、
  `backend\storage` 路徑存在。

- **備份佔用空間過大?**
  預設保留 14 份。可編輯 `backup.ps1` 中的 `$KeepCount` 調整份數。
