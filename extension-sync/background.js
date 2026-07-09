/**
 * 清晨沙灘 LINE 同步器 — background service worker (MV3)
 * 觸發模型(CONTRACT「同步觸發規則」,廢除 5 分鐘全輪詢):
 * 1. 'lineoaSync_hourly' alarm 依設定間隔(預設 60 分鐘)喚醒,
 *    僅在本地時間 [startHour, endHour)(預設 10–22)內向 chat.line.biz 分頁發 'lineoaSync_sync'。
 * 2. 'lineoaSync_heartbeat' alarm 每 1 分鐘向分頁發 'lineoaSync_lightTick':
 *    content script 只查後端 sync-requests(localhost,不碰 LINE 聊天 API),
 *    有 pending 建檔請求才執行建檔,順帶處理上輪遺留 pendingFiles。
 * 3. 找不到分頁時:整輪同步記錄狀態「未開啟 LINE 分頁」;輕量心跳靜默略過。
 * 4. 代 content script 轉送後端請求(lineoaSync_backendRequest),
 *    避開 https 頁面對 http://localhost 的 CORS / Private Network Access 限制。
 */
'use strict';

const OPTIONS_KEY = 'lineoaSync_options';
const STATUS_KEY = 'lineoaSync_status';
const HOURLY_ALARM = 'lineoaSync_hourly';       // 定時整輪(watchlist 增量),受 10–22 時窗限制
const HEARTBEAT_ALARM = 'lineoaSync_heartbeat'; // 輕量心跳(每 1 分鐘,只查後端),不受時窗限制
const DEFAULT_OPTIONS = { backendUrl: 'http://localhost:4680', extensionToken: '', intervalMinutes: 60, startHour: 10, endHour: 22 };

// ---------------------------------------------------------------- 工具

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

/** 小時數校驗(0-23 整數),不合法回退預設 */
function normalizeHour(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

async function getOptions() {
  const data = await storageGet([OPTIONS_KEY]);
  const opts = Object.assign({}, DEFAULT_OPTIONS, data[OPTIONS_KEY] || {});
  const n = Number(opts.intervalMinutes);
  opts.intervalMinutes = Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_OPTIONS.intervalMinutes;
  opts.startHour = normalizeHour(opts.startHour, DEFAULT_OPTIONS.startHour);
  opts.endHour = normalizeHour(opts.endHour, DEFAULT_OPTIONS.endHour);
  opts.extensionToken = typeof opts.extensionToken === 'string' ? opts.extensionToken.trim() : '';
  return opts;
}

/**
 * 讀取插件認證 Token(options 的「後端 API Token」= 後端 .env EXTENSION_TOKEN)。
 * 非空時所有發往後端的請求帶 header X-Extension-Token;空 = 過渡模式,不帶該 header。
 */
async function getExtensionToken() {
  try {
    return (await getOptions()).extensionToken;
  } catch (e) {
    return '';
  }
}

/**
 * 校驗傳入的 url origin 是否等於目前設定的 backendUrl origin。
 * 經由訊息通道(content script → background)帶入的後端 URL 只驗 http(s) 前綴不夠:
 * 任一分頁(或被入侵的 content script)都能請 background 對任意 http(s) 主機發請求
 * 並附上使用者 cookie / 認證 token(SSRF 樣式)。固定為「只允許使用者設定的後端來源」。
 * host_permissions 已收斂為 chat.line.biz / chat-content.line.biz / localhost / 127.0.0.1,
 * 非 localhost 後端需使用者於 options 動態授權(optional_host_permissions);
 * 未授權時 fetch 本就會失敗,此處提前擋下並回明確錯誤。
 */
async function isAllowedBackendUrl(url) {
  try {
    const opts = await getOptions();
    return new URL(url).origin === new URL(opts.backendUrl).origin;
  } catch (e) {
    return false;
  }
}

async function mergeStatus(patch) {
  try {
    const data = await storageGet([STATUS_KEY]);
    const cur = data[STATUS_KEY] || {};
    await storageSet({ [STATUS_KEY]: Object.assign({}, cur, patch) });
  } catch (e) {
    console.warn('[lineoaSync] 寫入狀態失敗', e);
  }
}

// ---------------------------------------------------------------- 鬧鐘排程

async function setupAlarms() {
  try {
    const opts = await getOptions();
    // clearAll 只作用於本擴充功能的 alarm(安全):一併掃掉舊版「每 5 分鐘全輪」
    // 等任何遺留名字——chrome.alarms 跨擴充功能更新持久,逐名 clear 掃不到舊名,
    // 殘留 alarm 會永久每 5 分鐘白白喚醒 service worker。
    await chrome.alarms.clearAll();
    // 定時整輪:intervalMinutes = 小時輪的間隔(預設 60 分鐘)
    chrome.alarms.create(HOURLY_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: opts.intervalMinutes,
    });
    // 輕量心跳:固定每 1 分鐘,不隨設定變動
    chrome.alarms.create(HEARTBEAT_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: 1,
    });
  } catch (e) {
    console.warn('[lineoaSync] 建立鬧鐘失敗', e);
  }
}

chrome.runtime.onInstalled.addListener(() => { setupAlarms(); });
chrome.runtime.onStartup.addListener(() => { setupAlarms(); });

// 設定變更(同步間隔/時段)時重建鬧鐘
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[OPTIONS_KEY]) setupAlarms();
});

/**
 * 本地時間是否在 [startHour, endHour) 內。
 * startHour === endHour 視為全天執行;startHour > endHour 視為跨夜時段(例如 22–6)。
 */
function isWithinSyncWindow(startHour, endHour, hour) {
  if (startHour === endHour) return true;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/** 定時整輪:alarm 照常觸發,handler 檢查本地時間在 [startHour, endHour) 內才跑 */
async function handleHourlyAlarm() {
  const opts = await getOptions();
  const hour = new Date().getHours();
  if (!isWithinSyncWindow(opts.startHour, opts.endHour, hour)) {
    return; // 時窗外:靜默跳過,不動狀態(新訊息偵測與手動同步不受此限)
  }
  await triggerSync('scheduled');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm) return;
  if (alarm.name === HOURLY_ALARM) {
    handleHourlyAlarm().catch((e) => console.warn('[lineoaSync] 定時同步失敗', e));
  } else if (alarm.name === HEARTBEAT_ALARM) {
    triggerLightTick().catch((e) => console.warn('[lineoaSync] 輕量心跳失敗', e));
  }
});

// ---------------------------------------------------------------- 觸發同步

function sendMessageToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(resp);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

// content.js 同步中每 20s 心跳一次(heartbeatAt);running 且心跳未逾時 = 確有同步在跑。
// 逾時(分頁崩潰/關閉殘留 running:true)則照常派發,避免永久卡死。
const SYNC_STALE_MS = 2 * 60 * 1000;

/**
 * 分頁是否為 /{botId}/... 頁(botId = U + 32 位十六進位,與 content.js getBotId 同格式)。
 * content_scripts matches 為 https://chat.line.biz/*,根頁/帳號選擇頁也會注入,
 * 但那些分頁解析不出 botId、無法執行同步/建檔;派發前把有 botId 的分頁排前面,
 * 避免整輪/心跳被無 botId 的分頁受理後失敗,旁邊真正的聊天分頁永遠輪不到。
 * (tabs 權限已有,tab.url 可讀)
 */
function isBotPageTab(tab) {
  return /^https:\/\/chat\.line\.biz\/U[0-9a-f]{32}([/?#]|$)/i.test(String((tab && tab.url) || ''));
}

/** 把有 botId 的分頁排到前面(穩定排序,其餘保持 tabs.query 原順序) */
function sortBotPagesFirst(tabs) {
  tabs.sort((a, b) => (isBotPageTab(b) ? 1 : 0) - (isBotPageTab(a) ? 1 : 0));
  return tabs;
}

/** 找 chat.line.biz 分頁並發送同步指令;chatId(選填)= 只同步該客戶(popup「立即同步此客戶」) */
async function triggerSync(trigger, chatId) {
  // 派發前先讀全域同步狀態:content.js 的 syncing 鎖是每個分頁獨立的,
  // tabs.query 順序任意,若空閒分頁排在忙碌分頁之前,逐分頁探詢會在
  // 建檔長時間運行(可遠超 alarm 週期)期間於另一分頁啟動第二輪並發同步——
  // 同一 pending 建檔請求被重複執行、對 LINE 的合計請求間隔減半(風控風險)。
  try {
    const data = await storageGet([STATUS_KEY]);
    const st = data[STATUS_KEY] || {};
    const beat = Math.max(Number(st.heartbeatAt) || 0, Number(st.lastStartAt) || 0);
    if (st.running === true && Date.now() - beat < SYNC_STALE_MS) {
      // 不覆寫 storage 狀態:執行中的分頁擁有狀態
      return { ok: false, error: '同步進行中' };
    }
  } catch (e) {
    // 狀態讀取失敗:退回逐分頁探詢(分頁內仍有 syncing 鎖擋重複)
  }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://chat.line.biz/*' });
  } catch (e) {
    tabs = [];
  }

  if (!tabs || tabs.length === 0) {
    const error = '未開啟 LINE 分頁';
    await mergeStatus({ running: false, lastResult: 'error', lastError: error, lastAttemptAt: Date.now() });
    return { ok: false, error };
  }
  sortBotPagesFirst(tabs); // 優先派發給能解析 botId 的分頁

  let lastError = null;
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    try {
      const msg = { type: 'lineoaSync_sync', trigger: trigger || 'manual' };
      if (typeof chatId === 'string' && chatId) msg.chatId = chatId; // content.js 據此只同步單一客戶
      const resp = await sendMessageToTab(tab.id, msg);
      if (resp && resp.ok) return { ok: true, started: true };
      if (resp && resp.error === '同步進行中') {
        // 該分頁已有同步在跑:視為本輪已啟動,立即返回,不再向其他分頁派發。
        // content.js 的 syncing 鎖是每個分頁獨立的,若繼續派發會在另一分頁
        // 啟動第二輪並發同步:各自 300ms 節流疊加(對 LINE 合計間隔可低至 ~150ms)、
        // 共享的待下載佇列被重複下載。不覆寫 storage 狀態(執行中的分頁擁有狀態)。
        return { ok: false, error: '同步進行中' };
      }
      lastError = (resp && resp.error) || '分頁未回應';
    } catch (e) {
      // content script 未載入(例如安裝插件前就開著的分頁)
      lastError = 'LINE 分頁尚未載入同步腳本,請重新整理該分頁';
    }
  }
  await mergeStatus({ running: false, lastResult: 'error', lastError, lastAttemptAt: Date.now() });
  return { ok: false, error: lastError };
}

/**
 * 輕量心跳(每 1 分鐘):向 chat.line.biz 分頁發 'lineoaSync_lightTick',
 * content script 只查後端 sync-requests + 處理遺留 pendingFiles,絕不碰 LINE 聊天 API。
 * 與 triggerSync 不同:全程靜默——找不到分頁/分頁未載入腳本都不寫錯誤狀態,
 * 否則每分鐘一次的心跳會把 popup 的正常同步狀態洗掉。
 */
async function triggerLightTick() {
  // 有整輪同步在跑(running + 心跳未逾時)則跳過,避免與建檔/整輪並發
  try {
    const data = await storageGet([STATUS_KEY]);
    const st = data[STATUS_KEY] || {};
    const beat = Math.max(Number(st.heartbeatAt) || 0, Number(st.lastStartAt) || 0);
    if (st.running === true && Date.now() - beat < SYNC_STALE_MS) return;
  } catch (e) {
    // 狀態讀取失敗:照常派發(content.js 內仍有 syncing 鎖擋重複)
  }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://chat.line.biz/*' });
  } catch (e) {
    tabs = [];
  }
  // 優先派發給能解析 botId 的分頁:根頁分頁雖可處理 pendingFiles(項目自帶 botId),
  // 但 pending 建檔請求在其上只會「暫緩」——有聊天分頁時應讓它先受理
  sortBotPagesFirst(tabs);

  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    try {
      const resp = await sendMessageToTab(tab.id, { type: 'lineoaSync_lightTick' });
      // 已受理或該分頁正在同步:本次心跳結束,不再向其他分頁派發
      if (resp && (resp.ok || resp.error === '同步進行中')) return;
    } catch (e) {
      // content script 未載入(例如安裝插件前就開著的分頁):試下一個分頁
    }
  }
}

// ---------------------------------------------------------------- 後端請求轉送

/**
 * 代 content script 執行後端請求。
 * msg: { url, method, json? }
 * (檔案上傳一律走 lineoaSync_lineDownload:SW 內 blob→FormData 直傳,不經 base64/sendMessage)
 * 僅允許使用者設定的 backendUrl(http/https),不對其他第三方發送任何資料。
 */
async function handleBackendRequest(msg) {
  const url = String(msg.url || '');
  if (!/^https?:\/\//.test(url)) {
    return { ok: false, status: 0, error: '無效的後端網址' };
  }
  // 只允許發往使用者設定的後端來源(防止經訊息通道帶入任意 URL 的 SSRF 樣式轉發)
  if (!(await isAllowedBackendUrl(url))) {
    return { ok: false, status: 0, error: '後端網址與設定不符,已拒絕轉送' };
  }
  try {
    // 插件認證(CONTRACT「帳號與認證」):token 非空時帶 X-Extension-Token,空則不帶(過渡模式)
    const token = await getExtensionToken();
    let init;
    const method = String(msg.method || 'POST').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      init = { method }; // GET/HEAD 不可帶 body
      if (token) init.headers = { 'X-Extension-Token': token };
    } else {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-Extension-Token'] = token;
      init = {
        method,
        headers,
        body: JSON.stringify(msg.json === undefined ? {} : msg.json),
      };
    }
    const res = await fetch(url, init);
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : (data && data.error) || null };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.message) || String(e) };
  }
}

// ---------------------------------------------------------------- LINE 檔案下載 + 上傳(代 content script)

const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // 與後端/CONTRACT 一致:300MB 上限,超限跳過(記入跳過清單)

/**
 * 代 content script 下載 LINE 檔案原檔並直接上傳後端(lineoaSync_lineDownload)。
 * - service worker 憑 manifest host_permissions 可跨源 fetch chat-content.line.biz
 *   並攜帶 LINE cookie,不受頁面(chat.line.biz)CORS 約束。
 * - 下載與上傳皆在 SW 內完成,大檔不經 chrome.runtime.sendMessage,避開訊息體積上限。
 * msg: { url, backendUrl, fields:{chatId,lineMessageId,contentHash,fileName,expiredAt,mimeType} }
 * 僅允許 chat-content.line.biz 的下載網址與使用者設定的 backendUrl,不涉及其他第三方。
 */
async function handleLineDownload(msg) {
  const url = String(msg.url || '');
  if (!/^https:\/\/chat-content\.line\.biz\//.test(url)) {
    return { ok: false, status: 0, error: '無效的檔案下載網址' };
  }
  const backendUrl = String(msg.backendUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(backendUrl)) {
    return { ok: false, status: 0, error: '無效的後端網址' };
  }
  // 上傳目的地也只允許使用者設定的後端來源(同 handleBackendRequest)
  if (!(await isAllowedBackendUrl(backendUrl))) {
    return { ok: false, status: 0, error: '後端網址與設定不符,已拒絕上傳' };
  }
  try {
    // 裸 URL、credentials:'include'(CONTRACT.md「LINE 內部 API」)
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      // stage:'download' 供 content script 判斷 401/403 是 LINE 登入失效(needLogin)
      return { ok: false, status: res.status, stage: 'download', error: `下載檔案 ${res.status}` };
    }
    const blob = await res.blob();
    if (blob.size > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        status: 0,
        code: 'TOO_LARGE',
        error: `檔案過大(${(blob.size / 1048576).toFixed(1)} MB,超過 ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB 上限),已跳過`,
      };
    }
    const fields = msg.fields || {};
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) fd.append(k, String(v));
    }
    fd.set('fileSize', String(blob.size));
    if (!fields.mimeType) {
      fd.set('mimeType', blob.type || 'application/octet-stream');
    }
    fd.append('file', blob, fields.fileName || 'file');
    // 插件認證:token 非空時帶 X-Extension-Token(FormData 的 multipart boundary 由瀏覽器自動附加)
    const token = await getExtensionToken();
    const upInit = { method: 'POST', body: fd };
    if (token) upInit.headers = { 'X-Extension-Token': token };
    const upRes = await fetch(backendUrl + '/api/ingest/file', upInit);
    let data = null;
    try {
      data = await upRes.json();
    } catch (e) {
      data = null;
    }
    return {
      ok: upRes.ok,
      status: upRes.status,
      stage: upRes.ok ? undefined : 'upload',
      data,
      error: upRes.ok ? null : (data && data.error) || `後端 ${upRes.status} /api/ingest/file`,
    };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.message) || String(e) };
  }
}

// ---------------------------------------------------------------- 訊息入口

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;

  if (msg.type === 'lineoaSync_syncNow') {
    // 選填 msg.chatId:popup「立即同步此客戶」→ 轉發給 content script 只同步該客戶
    triggerSync(typeof msg.chatId === 'string' && msg.chatId ? 'syncOne' : 'manual', msg.chatId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true; // 非同步回覆
  }

  if (msg.type === 'lineoaSync_backendRequest') {
    handleBackendRequest(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, status: 0, error: (e && e.message) || String(e) }));
    return true; // 非同步回覆
  }

  if (msg.type === 'lineoaSync_lineDownload') {
    handleLineDownload(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, status: 0, error: (e && e.message) || String(e) }));
    return true; // 非同步回覆
  }

  return undefined;
});

// service worker 每次喚醒都確保鬧鐘存在(alarms 在瀏覽器重啟後通常保留,此為保險)
chrome.alarms.get(HOURLY_ALARM, (alarm) => {
  if (!alarm) setupAlarms();
});
chrome.alarms.get(HEARTBEAT_ALARM, (alarm) => {
  if (!alarm) setupAlarms();
});
