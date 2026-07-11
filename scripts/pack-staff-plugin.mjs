// pack-staff-plugin.mjs
// 把 extension-sync/ 打包成 webui/plugin.zip 供同仁在登入頁下載。
// 無第三方 zip 依賴 → 以 Node 準備暫存目錄後,呼叫 PowerShell Compress-Archive 產出 zip。
// 用法:node scripts/pack-staff-plugin.mjs
'use strict';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  cpSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'extension-sync');
const OUT_DIR = join(ROOT, 'webui');
const OUT_ZIP = join(OUT_DIR, 'plugin.zip');

// 安裝說明(繁中);刻意不含任何管理員密碼
const README_TXT = [
  'LINE OA 同步插件 — 同仁安裝說明',
  '======================================',
  '',
  '這是給同仁使用的 Chrome 同步插件,負責把你負責的 LINE 客戶對話同步到後台。',
  '',
  '【安裝步驟】',
  '1. 解壓縮本檔案,得到 extension-sync 資料夾。',
  '2. 開啟 Chrome,網址列輸入 chrome://extensions 並前往。',
  '3. 右上角開啟「開發人員模式 / Developer mode」。',
  '4. 點「載入未封裝項目 / Load unpacked」,選擇剛剛解壓出來的 extension-sync 資料夾。',
  '5. 安裝完成後,點插件圖示 → 進入「選項 / Options」設定。',
  '',
  '【必要設定】',
  '- 後端網址:http://<主機IP>:4680',
  '  (<主機IP> 請向管理員索取,例如 http://192.168.1.100:4680)',
  '- API Token:向管理員索取後填入 Token 欄位。',
  '',
  '【使用方式】',
  '- 於 chat.line.biz 開啟你要追蹤的客戶對話,左下角會出現「⟳ 同步」浮動按鈕。',
  '- 首次點「⟳ 同步」會把該客戶加入同步清單,之後每小時(10:00–22:00)自動增量同步。',
  '- 點插件圖示可查看上次同步狀態、手動立即同步、管理同步清單。',
  '',
  '【注意事項】',
  '- 本插件只會把資料送到你設定的後端網址,不會外傳任何第三方。',
  '- 若插件顯示「LINE 登入已失效」,請重新登入 chat.line.biz。',
  '- 有任何問題請洽管理員。',
  '',
].join('\r\n');

function fail(msg) {
  console.error('[pack-staff-plugin] 錯誤:' + msg);
  process.exit(1);
}

if (!existsSync(SRC) || !statSync(SRC).isDirectory()) {
  fail('找不到來源資料夾 extension-sync/:' + SRC);
}
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// 暫存目錄:staging/extension-sync/* + staging/安裝說明.txt
const stage = mkdtempSync(join(tmpdir(), 'lineoa-plugin-'));
try {
  const stagedExt = join(stage, 'extension-sync');
  cpSync(SRC, stagedExt, { recursive: true });
  writeFileSync(join(stage, '安裝說明.txt'), README_TXT, 'utf8');

  // 舊檔先刪(Compress-Archive 不覆蓋既有檔會報錯,-Force 才會)
  if (existsSync(OUT_ZIP)) rmSync(OUT_ZIP, { force: true });

  // 呼叫 PowerShell Compress-Archive;-Path 指向 staging 內容(用萬用字元收進根層)
  const psCmd =
    "$ProgressPreference='SilentlyContinue';" +
    `Compress-Archive -Path (Join-Path '${stage}' '*') -DestinationPath '${OUT_ZIP}' -Force`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  });
  if (r.status !== 0) {
    fail('Compress-Archive 失敗:' + (r.stderr || r.stdout || ('exit ' + r.status)));
  }
  if (!existsSync(OUT_ZIP)) fail('壓縮後找不到輸出檔:' + OUT_ZIP);

  const kb = (statSync(OUT_ZIP).size / 1024).toFixed(1);
  console.log('[pack-staff-plugin] 完成 → ' + OUT_ZIP + ' (' + kb + ' KB)');
} finally {
  rmSync(stage, { recursive: true, force: true });
}
