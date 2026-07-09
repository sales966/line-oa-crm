<#
================================================================================
 LINE OA 客戶進度中樞 — 開機自啟 + 每日備份 排程建立腳本 (setup-autostart.ps1)
================================================================================
 本腳本會建立(或移除)兩個 Windows 排程工作:

   (a) LineOA-Backend-Autostart
       觸發時機:開機時 (AtStartup)
       動作:執行專案根目錄的 start.bat(啟動 Fastify 後端,埠 4680)
       執行身分:SYSTEM(免密碼、免登入即可啟動)

   (b) LineOA-Daily-Backup
       觸發時機:每天 02:00
       動作:執行專案根目錄的 backup.bat(呼叫 scripts-ops\backup.ps1)
       執行身分:SYSTEM
       重要:啟用「錯過就盡快補跑」(StartWhenAvailable)與「喚醒執行」
       (WakeToRun)。工作站在凌晨 02:00 多半關機/睡眠,若沿用純 schtasks
       DAILY 排程,錯過的備份不會補跑、也不會告警,備份等於形同虛設。
       這裡改用 Register-ScheduledTask + New-ScheduledTaskSettingsSet,
       讓錯過的備份在開機/喚醒後盡快補跑。

 為何不用 schtasks.exe:
   1. schtasks CLI 無法設定 StartWhenAvailable / WakeToRun,錯過的每日備份
      不會補跑(本專案最關鍵的可靠度問題)。
   2. schtasks /TR 需把含內嵌雙引號的命令字串傳給原生 exe,Windows
      PowerShell 5.1 對原生程式引數的引號跳脫有已知脆弱性,一旦專案路徑
      含空白就會壞。改用 New-ScheduledTaskAction -Execute 以結構化參數
      傳遞,完全不靠字串引號。

 --------------------------------------------------------------------------
 使用方式(務必用「系統管理員身分」開啟 PowerShell):
   建立/更新排程:
     powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts-ops\setup-autostart.ps1"
   移除排程:
     powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts-ops\setup-autostart.ps1" -Remove
   建立後可用以下指令檢視:
     Get-ScheduledTask -TaskName "LineOA-Backend-Autostart" | Get-ScheduledTaskInfo
     Get-ScheduledTask -TaskName "LineOA-Daily-Backup"      | Get-ScheduledTaskInfo
   (亦可繼續用 schtasks /Query /TN "..." /V /FO LIST 檢視。)

 備註:
   * 若偏好「使用者登入時」才啟動後端(而非開機即啟),
     可將下方 $AutostartTrigger 由 'AtStartup' 改為 'AtLogon'。
   * SYSTEM 身分可讀寫本專案檔案;node 位於 Program Files 為系統層級安裝,
     SYSTEM 亦可執行,因此無需儲存使用者密碼。
================================================================================
#>

param(
    [switch]$Remove   # 帶上 -Remove 則改為刪除這兩個排程
)

$ErrorActionPreference = 'Stop'

# ---- 路徑計算 ----------------------------------------------------------------
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path      # ...\scripts-ops
$ProjectRoot = Split-Path -Parent $ScriptDir                        # ...\lineoa
$StartBat    = Join-Path $ProjectRoot 'start.bat'
$BackupBat   = Join-Path $ProjectRoot 'backup.bat'

$TaskAutostart = 'LineOA-Backend-Autostart'
$TaskBackup    = 'LineOA-Daily-Backup'

$AutostartTrigger = 'AtStartup'   # 可改為 'AtLogon'
$BackupTime       = '02:00'

# ---- 系統管理員檢查 ----------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal] `
            [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '[錯誤] 請以「系統管理員身分」開啟 PowerShell 後再執行本腳本。' -ForegroundColor Red
    Write-Host '       (開始功能表 → 搜尋 PowerShell → 右鍵「以系統管理員身分執行」)'
    exit 1
}

# ---- 移除模式 ----------------------------------------------------------------
if ($Remove) {
    foreach ($tn in @($TaskAutostart, $TaskBackup)) {
        Write-Host ("移除排程: {0}" -f $tn)
        try {
            Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction Stop
        } catch {
            Write-Host ("  (略過:{0})" -f $_.Exception.Message) -ForegroundColor DarkGray
        }
    }
    Write-Host '已移除排程(若原本不存在會顯示略過訊息,可忽略)。' -ForegroundColor Yellow
    exit 0
}

# ---- 前置檢查 ----------------------------------------------------------------
if (-not (Test-Path $StartBat)) {
    Write-Host ("[錯誤] 找不到 start.bat: {0}" -f $StartBat) -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $BackupBat)) {
    Write-Host ("[錯誤] 找不到 backup.bat: {0}" -f $BackupBat) -ForegroundColor Red
    exit 1
}

# ---- 共用:以 SYSTEM 最高權限執行 -------------------------------------------
# 結構化傳參,不依賴字串引號,路徑含空白亦安全。
$Principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' `
                -LogonType ServiceAccount -RunLevel Highest

# ---- (a) 建立開機自啟排程 ---------------------------------------------------
Write-Host ("建立排程 (a) 開機自啟後端: {0}" -f $TaskAutostart) -ForegroundColor Cyan

$AutostartAction = New-ScheduledTaskAction -Execute $StartBat -WorkingDirectory $ProjectRoot

if ($AutostartTrigger -eq 'AtLogon') {
    $trgA = New-ScheduledTaskTrigger -AtLogOn
} else {
    $trgA = New-ScheduledTaskTrigger -AtStartup
}

# 後端啟動即長駐,關閉「執行逾時自動停止」(預設 3 天會被砍)。
$AutostartSettings = New-ScheduledTaskSettingsSet `
                        -StartWhenAvailable `
                        -AllowStartIfOnBatteries `
                        -DontStopIfGoingOnBatteries `
                        -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskAutostart -Force `
    -Action $AutostartAction -Trigger $trgA `
    -Principal $Principal -Settings $AutostartSettings `
    -Description 'LINE OA 後端開機自啟(埠 4680)' | Out-Null

# ---- (b) 建立每日備份排程 ---------------------------------------------------
Write-Host ("建立排程 (b) 每日 {0} 備份: {1}" -f $BackupTime, $TaskBackup) -ForegroundColor Cyan

$BackupAction = New-ScheduledTaskAction -Execute $BackupBat -WorkingDirectory $ProjectRoot
$trgB         = New-ScheduledTaskTrigger -Daily -At $BackupTime

# 關鍵可靠度設定:
#   -StartWhenAvailable      錯過 02:00(關機/睡眠)後,開機/喚醒即盡快補跑
#   -WakeToRun               若機器僅睡眠,允許喚醒執行備份
#   -AllowStartIfOnBatteries 筆電未插電也照跑(否則預設不跑)
$BackupSettings = New-ScheduledTaskSettingsSet `
                    -StartWhenAvailable `
                    -WakeToRun `
                    -AllowStartIfOnBatteries `
                    -DontStopIfGoingOnBatteries `
                    -ExecutionTimeLimit ([TimeSpan]::FromHours(2))

Register-ScheduledTask -TaskName $TaskBackup -Force `
    -Action $BackupAction -Trigger $trgB `
    -Principal $Principal -Settings $BackupSettings `
    -Description 'LINE OA 每日備份(錯過會於開機/喚醒後補跑)' | Out-Null

Write-Host ''
Write-Host '===== 排程建立完成 =====' -ForegroundColor Green
Write-Host ("  (a) {0}  →  開機時執行 start.bat" -f $TaskAutostart)
Write-Host ("  (b) {0}  →  每天 {1} 執行 backup.bat(錯過會補跑)" -f $TaskBackup, $BackupTime)
Write-Host ''
Write-Host '可用以下指令驗證:'
Write-Host ('  Get-ScheduledTask -TaskName "{0}" | Get-ScheduledTaskInfo' -f $TaskAutostart)
Write-Host ('  Get-ScheduledTask -TaskName "{0}" | Get-ScheduledTaskInfo' -f $TaskBackup)
Write-Host '  (或沿用 schtasks /Query /TN "..." /V /FO LIST)'
Write-Host ''
Write-Host '如需立即測試備份,可手動觸發一次:'
Write-Host ('  Start-ScheduledTask -TaskName "{0}"' -f $TaskBackup)
exit 0
