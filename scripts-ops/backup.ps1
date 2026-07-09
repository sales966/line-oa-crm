<#
================================================================================
 LINE OA 客戶進度中樞 — 自動備份腳本 (backup.ps1)
================================================================================
 用途:
   將 backend\data(SQLite 主資料庫 app.db)與 backend\storage(上傳檔案)
   完整備份到 backend\backups\backup-YYYYMMDD-HHmmss\ 之下。

 特色:
   1. SQLite 熱備份:優先使用 better-sqlite3 的線上 .backup(),即使後端
      正在執行、資料庫正在寫入,也能取得「單一致性」的 app.db 快照。
      (避免直接 copy .db + .db-wal 時可能發生的「撕裂」不一致。)
   2. 若 node / better-sqlite3 不可用,自動退回 robocopy 整個 data 夾
      (連同 .db / .db-wal / .db-shm 一起複製,還原時 SQLite 會自行重放 WAL)。
   3. storage 夾一律以 robocopy 完整複製。
   4. 保留策略:只保留最近 14 份備份,更舊的自動刪除。

 手動執行:
   從「開始功能表」開啟 PowerShell,執行:
     powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\tomor\Desktop\lineoa\scripts-ops\backup.ps1"
   或直接雙擊專案根目錄的 backup.bat。

 排程執行:
   由 setup-autostart.ps1 建立每天 02:00 的 Windows 排程(呼叫 backup.bat)。
================================================================================
#>

$ErrorActionPreference = 'Stop'

# ---- 路徑計算(以本腳本所在位置往上推,不依賴當前工作目錄)-------------------
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path      # ...\scripts-ops
$ProjectRoot = Split-Path -Parent $ScriptDir                        # ...\lineoa
$BackendRoot = Join-Path $ProjectRoot 'backend'
$DataDir     = Join-Path $BackendRoot 'data'
$StorageDir  = Join-Path $BackendRoot 'storage'
$BackupsRoot = Join-Path $BackendRoot 'backups'
$DbPath      = Join-Path $DataDir 'app.db'
$NodeModules = Join-Path $BackendRoot 'node_modules'

$KeepCount   = 14                                                   # 保留份數
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'
$DestRoot    = Join-Path $BackupsRoot ("backup-{0}" -f $Stamp)
$DestData    = Join-Path $DestRoot 'data'
$DestStorage = Join-Path $DestRoot 'storage'
$LogFile     = Join-Path $BackupsRoot 'backup.log'

# ---- 簡易記錄函式 ------------------------------------------------------------
function Write-Log {
    param([string]$Message)
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
    Write-Host $line
    try {
        if (-not (Test-Path $BackupsRoot)) {
            New-Item -ItemType Directory -Path $BackupsRoot -Force | Out-Null
        }
        Add-Content -Path $LogFile -Value $line -Encoding UTF8
    } catch {
        # 記錄失敗不應中斷備份
    }
}

# ---- 長路徑安全刪除 ----------------------------------------------------------
# storage\files 內是 LINE 檔案 ID,路徑常超過 Windows MAX_PATH(260),
# Remove-Item 會刪除失敗。改用 robocopy 從空目錄鏡射(/MIR)清空目標
# (robocopy 原生支援長路徑),清空後外殼即可正常刪除。
function Remove-TreeLongPath {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    $empty = Join-Path $env:TEMP ('__lineoa_empty_' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $empty -Force | Out-Null
    try {
        robocopy $empty $Path /MIR /NP /NFL /NDL /R:1 /W:1 | Out-Null
    } finally {
        Remove-Item -Path $empty -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $Path  -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Log '===== 備份開始 ====='
Write-Log ("專案根目錄: {0}" -f $ProjectRoot)

# ---- 前置檢查 ----------------------------------------------------------------
if (-not (Test-Path $BackendRoot)) {
    Write-Log ("找不到 backend 目錄,終止: {0}" -f $BackendRoot)
    exit 1
}

New-Item -ItemType Directory -Path $DestData    -Force | Out-Null
New-Item -ItemType Directory -Path $DestStorage -Force | Out-Null

# ---- 步驟一:SQLite 資料庫熱備份 --------------------------------------------
$dbBackupOk = $false
$node = Get-Command node -ErrorAction SilentlyContinue

if ($node -and (Test-Path $DbPath) -and (Test-Path (Join-Path $NodeModules 'better-sqlite3'))) {
    Write-Log '嘗試以 better-sqlite3 線上 .backup() 進行熱備份...'
    try {
        # 以 CommonJS require 載入 better-sqlite3;NODE_PATH 讓 node 找到 backend\node_modules
        $env:NODE_PATH = $NodeModules
        $destDbForNode = (Join-Path $DestData 'app.db')

        # 傳入來源與目的路徑作為 argv;.backup() 回傳 Promise,process 會等它完成
        # 注意:JS 內字串一律用「單引號」。PowerShell 呼叫原生 exe 時會吞掉
        # 引數中的雙引號,導致 require("...") 變成 require(...) 而報錯。
        $js = @'
const Database = require('better-sqlite3');
const src = process.argv[1];
const dest = process.argv[2];
const db = new Database(src, { readonly: true, fileMustExist: true });
db.backup(dest)
  .then(() => { db.close(); console.log('OK'); process.exit(0); })
  .catch((e) => { console.error(String(e)); process.exit(1); });
'@
        $out = & $node.Source '-e' $js $DbPath $destDbForNode 2>&1
        if ($LASTEXITCODE -eq 0) {
            $dbBackupOk = $true
            Write-Log ("SQLite 線上備份成功: {0}" -f $destDbForNode)
        } else {
            Write-Log ("SQLite 線上備份失敗(exit={0}): {1}" -f $LASTEXITCODE, ($out -join ' '))
        }
    } catch {
        Write-Log ("SQLite 線上備份發生例外: {0}" -f $_.Exception.Message)
    } finally {
        Remove-Item Env:\NODE_PATH -ErrorAction SilentlyContinue
    }
} else {
    Write-Log 'node 或 better-sqlite3 不可用(或 app.db 不存在),改用檔案複製。'
}

# ---- 步驟一(退回方案):robocopy 整個 data 夾 ------------------------------
# 若線上備份未成功,直接複製 data 夾(含 .db / .db-wal / .db-shm)。
if (-not $dbBackupOk) {
    if (Test-Path $DataDir) {
        Write-Log '以 robocopy 複製整個 data 夾(含 WAL/SHM)...'
        robocopy $DataDir $DestData /E /R:3 /W:2 /NP /NFL /NDL | Out-Null
        $rc = $LASTEXITCODE
        if ($rc -lt 8) {
            Write-Log ("data 夾複製完成(robocopy code={0})。" -f $rc)
        } else {
            Write-Log ("data 夾複製發生錯誤(robocopy code={0})!" -f $rc)
        }
    } else {
        Write-Log ("找不到 data 目錄: {0}" -f $DataDir)
    }
}

# ---- 步驟二:storage 夾完整複製 --------------------------------------------
if (Test-Path $StorageDir) {
    Write-Log '以 robocopy 複製 storage 夾...'
    robocopy $StorageDir $DestStorage /E /R:3 /W:2 /NP /NFL /NDL | Out-Null
    $rc = $LASTEXITCODE
    if ($rc -lt 8) {
        Write-Log ("storage 夾複製完成(robocopy code={0})。" -f $rc)
    } else {
        Write-Log ("storage 夾複製發生錯誤(robocopy code={0})!" -f $rc)
    }
} else {
    Write-Log ("找不到 storage 目錄(略過): {0}" -f $StorageDir)
}

Write-Log ("本次備份輸出: {0}" -f $DestRoot)

# ---- 步驟三:保留策略(只留最近 14 份)------------------------------------
try {
    $all = Get-ChildItem -Path $BackupsRoot -Directory -Filter 'backup-*' -ErrorAction SilentlyContinue |
           Sort-Object Name -Descending
    if ($all -and $all.Count -gt $KeepCount) {
        $toRemove = $all | Select-Object -Skip $KeepCount
        foreach ($old in $toRemove) {
            Write-Log ("刪除舊備份: {0}" -f $old.Name)
            Remove-TreeLongPath -Path $old.FullName
        }
    }
    $remain = (Get-ChildItem -Path $BackupsRoot -Directory -Filter 'backup-*' -ErrorAction SilentlyContinue).Count
    Write-Log ("目前保留備份份數: {0}(上限 {1})。" -f $remain, $KeepCount)
} catch {
    Write-Log ("套用保留策略時發生錯誤: {0}" -f $_.Exception.Message)
}

Write-Log '===== 備份結束 ====='
exit 0
