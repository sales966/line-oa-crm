/**
 * 清晨沙灘 LINE 同步器 — 設定頁
 * 儲存 backendUrl(預設 http://localhost:4680)、後端 API Token extensionToken
 * (後端 .env 的 EXTENSION_TOKEN;可留空 = 過渡模式,不攜帶認證 header)、
 * 定時同步間隔分鐘數(預設 60)與定時同步時段 startHour/endHour(0-23,預設 10/22)
 * 到 chrome.storage.local['lineoaSync_options']。
 * 時段僅約束定時同步(background 的小時輪);新訊息偵測與手動同步不受限。
 */
'use strict';

const OPTIONS_KEY = 'lineoaSync_options';
const DEFAULT_OPTIONS = { backendUrl: 'http://localhost:4680', extensionToken: '', intervalMinutes: 60, startHour: 10, endHour: 22 };

const urlInput = document.getElementById('backend-url');
const tokenInput = document.getElementById('extension-token');
const intervalInput = document.getElementById('interval');
const startHourSelect = document.getElementById('start-hour');
const endHourSelect = document.getElementById('end-hour');
const saveBtn = document.getElementById('save');
const saveMsg = document.getElementById('save-msg');

function showMsg(text, isError) {
  saveMsg.textContent = text;
  saveMsg.classList.toggle('error', !!isError);
  if (!isError) {
    setTimeout(() => {
      if (saveMsg.textContent === text) saveMsg.textContent = '';
    }, 2500);
  }
}

/** 填入 0-23 的小時選項(顯示為 00:00 ~ 23:00) */
function fillHourOptions(select) {
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option');
    opt.value = String(h);
    opt.textContent = String(h).padStart(2, '0') + ':00';
    select.appendChild(opt);
  }
}

/** 小時數校驗(0-23 整數),不合法回退預設(與 background.js 一致) */
function normalizeHour(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

/**
 * 後端來源是否已被 manifest 固定 host_permissions 涵蓋:http 的 localhost / 127.0.0.1
 * (match pattern 不含埠,任意埠皆涵蓋)。這些不需要動態授權。
 */
function isBuiltinBackendOrigin(backendUrl) {
  try {
    const u = new URL(backendUrl);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch (e) {
    return false;
  }
}

/** 由 backendUrl 組出 optional_host_permissions 可請求的 origin match pattern(不含埠) */
function backendOriginPattern(backendUrl) {
  const u = new URL(backendUrl);
  return u.protocol + '//' + u.hostname + '/*';
}

/**
 * 確保有存取該後端來源的權限:localhost/127.0.0.1 直接放行;
 * 其餘(例如區網 IP)以 chrome.permissions.request 向使用者動態請求
 * (manifest 的 host_permissions 已不含 http/https 全網通配,避免「所有網站」授權)。
 * request 須在使用者手勢(儲存按鈕點擊)同步鏈中呼叫;已授權時 request 會靜默回 true。
 */
function ensureBackendPermission(backendUrl, cb) {
  if (isBuiltinBackendOrigin(backendUrl)) { cb(true); return; }
  let origin;
  try {
    origin = backendOriginPattern(backendUrl);
  } catch (e) { cb(false); return; }
  try {
    chrome.permissions.request({ origins: [origin] }, (granted) => {
      cb(!!granted && !chrome.runtime.lastError);
    });
  } catch (e) {
    cb(false);
  }
}

function load() {
  chrome.storage.local.get([OPTIONS_KEY], (data) => {
    const opts = Object.assign({}, DEFAULT_OPTIONS, data[OPTIONS_KEY] || {});
    urlInput.value = opts.backendUrl;
    tokenInput.value = typeof opts.extensionToken === 'string' ? opts.extensionToken : '';
    intervalInput.value = String(opts.intervalMinutes);
    startHourSelect.value = String(normalizeHour(opts.startHour, DEFAULT_OPTIONS.startHour));
    endHourSelect.value = String(normalizeHour(opts.endHour, DEFAULT_OPTIONS.endHour));
    // 遷移提示:舊版以 http(s):*/* 通配授權任意後端;本版移除通配後,
    // 既存的非 localhost 後端需重新授權。缺權限時提示使用者點「儲存」重新授權。
    if (!isBuiltinBackendOrigin(opts.backendUrl)) {
      try {
        chrome.permissions.contains({ origins: [backendOriginPattern(opts.backendUrl)] }, (has) => {
          if (!has && !chrome.runtime.lastError) {
            showMsg('此後端網址尚未授權,請點「儲存」以允許存取', true);
          }
        });
      } catch (e) { /* 格式異常者由儲存流程處理 */ }
    }
  });
}

function save() {
  let backendUrl = String(urlInput.value || '').trim();
  if (backendUrl === '') backendUrl = DEFAULT_OPTIONS.backendUrl;
  backendUrl = backendUrl.replace(/\/+$/, ''); // 去除結尾斜線

  if (!/^https?:\/\/.+/.test(backendUrl)) {
    showMsg('後端網址必須以 http:// 或 https:// 開頭', true);
    return;
  }
  try {
    // eslint-disable-next-line no-new
    new URL(backendUrl);
  } catch (e) {
    showMsg('後端網址格式不正確', true);
    return;
  }

  // API Token:可留空(過渡模式,不攜帶認證 header),只做 trim 不做格式限制
  const extensionToken = String(tokenInput.value || '').trim();

  const n = Number(intervalInput.value);
  if (!Number.isFinite(n) || n < 1) {
    showMsg('同步間隔必須為大於等於 1 的分鐘數', true);
    return;
  }
  const intervalMinutes = Math.floor(n);
  const startHour = normalizeHour(startHourSelect.value, DEFAULT_OPTIONS.startHour);
  const endHour = normalizeHour(endHourSelect.value, DEFAULT_OPTIONS.endHour);

  // 非 localhost 後端:先取得該來源的動態授權(manifest 已移除 http(s):*/* 通配)。
  // 未授權則不儲存,避免存了一個插件無權存取的後端網址而每輪同步靜默失敗。
  ensureBackendPermission(backendUrl, (granted) => {
    if (!granted) {
      showMsg('未取得存取此後端網址的權限,請於彈窗點「允許」後再試(localhost 免授權)', true);
      return;
    }
    chrome.storage.local.set({ [OPTIONS_KEY]: { backendUrl, extensionToken, intervalMinutes, startHour, endHour } }, () => {
      if (chrome.runtime.lastError) {
        showMsg('儲存失敗:' + chrome.runtime.lastError.message, true);
      } else {
        showMsg('已儲存,新的間隔與時段將於下一輪生效');
        urlInput.value = backendUrl;
        tokenInput.value = extensionToken;
        intervalInput.value = String(intervalMinutes);
        startHourSelect.value = String(startHour);
        endHourSelect.value = String(endHour);
      }
    });
  });
}

saveBtn.addEventListener('click', save);
fillHourOptions(startHourSelect);
fillHourOptions(endHourSelect);
load();
