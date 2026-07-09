/**
 * 清晨沙灘 LINE 同步器 — popup(白名單模式)
 * 「目前聊天室」:向活躍分頁的 content script 發 getCurrentChat,
 * 在客戶聊天室時可一鍵「➕ 將此客戶加入同步」;
 * 「同步清單」:chrome.storage.local['lineoaSync_watchlist'],popup 直接讀寫,
 * 每項提供「立即同步」(單客戶)與「移除」。
 * 另顯示上次同步時間、各項計數、錯誤、登入失效警示、
 * 「建檔中的客戶」與「跳過的檔案」清單;提供「立即同步」(全部)與「開啟設定」。
 * 資料來源:chrome.storage.local,並監聽變更即時更新。
 * 客戶名等來自 LINE 的字串一律以 textContent 寫入 DOM(不可信輸入,防 XSS)。
 */
'use strict';

const STATUS_KEY = 'lineoaSync_status';
const SKIPPED_FILES_KEY = 'lineoaSync_skippedFiles';
const WATCHLIST_KEY = 'lineoaSync_watchlist';

const el = {
  currentBody: document.getElementById('current-body'),
  watchlistTitle: document.getElementById('watchlist-title'),
  watchlistList: document.getElementById('watchlist-list'),
  watchlistEmpty: document.getElementById('watchlist-empty'),
  badge: document.getElementById('status-badge'),
  lastSync: document.getElementById('last-sync'),
  chats: document.getElementById('count-chats'),
  messages: document.getElementById('count-messages'),
  files: document.getElementById('count-files'),
  notes: document.getElementById('count-notes'),
  pending: document.getElementById('pending-box'),
  errorBox: document.getElementById('error-box'),
  loginBox: document.getElementById('login-box'),
  tokenBox: document.getElementById('token-box'),
  fullsyncBox: document.getElementById('fullsync-box'),
  fullsyncList: document.getElementById('fullsync-list'),
  skippedBox: document.getElementById('skipped-box'),
  skippedCount: document.getElementById('skipped-count'),
  skippedList: document.getElementById('skipped-list'),
  syncBtn: document.getElementById('sync-now'),
  openOptions: document.getElementById('open-options'),
};

function formatTime(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '尚未同步';
  try {
    return new Date(ts).toLocaleString('zh-TW', { hour12: false });
  } catch (e) {
    return String(ts);
  }
}

function render(status) {
  const s = status || {};
  const counts = s.counts || {};

  el.lastSync.textContent = formatTime(s.lastSyncAt);
  el.chats.textContent = String(counts.chats || 0);
  el.messages.textContent = String(counts.messages || 0);
  el.files.textContent = String(counts.files || 0);
  el.notes.textContent = String(counts.notes || 0);

  el.badge.classList.remove('error', 'running', 'warn');
  if (s.running) {
    el.badge.textContent = '同步中…';
    el.badge.classList.add('running');
    el.syncBtn.disabled = true;
    el.syncBtn.textContent = '同步中…';
  } else {
    el.syncBtn.disabled = false;
    el.syncBtn.textContent = '立即同步';
    if (s.lastResult === 'ok') {
      el.badge.textContent = '正常';
    } else if (s.lastResult === 'partial') {
      // 部分成功用黃色警告樣式,紅色只留給「錯誤」,避免紅底配「成功」自相矛盾
      el.badge.textContent = '部分成功';
      el.badge.classList.add('warn');
    } else if (s.lastResult === 'error') {
      el.badge.textContent = '錯誤';
      el.badge.classList.add('error');
    } else {
      el.badge.textContent = '待機';
    }
  }

  if (typeof s.pendingFiles === 'number' && s.pendingFiles > 0) {
    el.pending.textContent = `尚有 ${s.pendingFiles} 個檔案待下輪同步下載`;
    el.pending.style.display = 'block';
  } else {
    el.pending.style.display = 'none';
  }

  if (s.lastError) {
    el.errorBox.textContent = String(s.lastError);
    el.errorBox.style.display = 'block';
  } else {
    el.errorBox.style.display = 'none';
  }

  // 登入偵測(CONTRACT):LINE API 回 401/403 → 醒目紅字提示
  el.loginBox.style.display = s.needLogin ? 'block' : 'none';

  // 插件認證(CONTRACT「帳號與認證」):後端回 401 且已設 token → 紅字提示;
  // 與 needLogin 互不影響,可同時顯示
  el.tokenBox.style.display = s.tokenError ? 'block' : 'none';

  // 建檔中的客戶(按需建檔 pending 佇列)
  const fullSync = Array.isArray(s.fullSyncQueue) ? s.fullSyncQueue : [];
  if (fullSync.length > 0) {
    el.fullsyncList.textContent = '';
    for (const q of fullSync) {
      if (!q) continue;
      const li = document.createElement('li');
      li.textContent = q.name ? q.name : q.chatId || '';
      li.title = q.chatId || '';
      el.fullsyncList.appendChild(li);
    }
    el.fullsyncBox.style.display = 'block';
  } else {
    el.fullsyncBox.style.display = 'none';
  }
}

/** 跳過的檔案(超過 300MB 或最終下載失敗;不准靜默丟棄) */
function renderSkipped(list) {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length === 0) {
    el.skippedBox.style.display = 'none';
    return;
  }
  el.skippedCount.textContent = `(${arr.length})`;
  el.skippedList.textContent = '';
  for (const f of arr.slice(0, 30)) {
    if (!f) continue;
    const li = document.createElement('li');
    li.textContent = `${f.fileName || f.contentHash || '?'} — ${f.reason || '下載失敗'}`;
    el.skippedList.appendChild(li);
  }
  el.skippedBox.style.display = 'block';
}

// ------------------------------------------------ 白名單(同步清單)與目前聊天室

let watchlist = [];          // [{chatId, name, addedAt}]
let currentChat = null;      // {botId, chatId, name}|null(null = 非客戶聊天室)
let currentHint = '偵測中…'; // currentChat 為 null 時顯示的提示文字

function sanitizeWatchlist(list) {
  return Array.isArray(list)
    ? list.filter((w) => w && typeof w.chatId === 'string' && w.chatId)
    : [];
}

function saveWatchlist(list) {
  // 寫入後由 storage.onChanged 回頭更新 watchlist 並重繪,單一資料流
  chrome.storage.local.set({ [WATCHLIST_KEY]: list });
}

function inWatchlist(chatId) {
  return watchlist.some((w) => w.chatId === chatId);
}

/** 「目前聊天室」區塊(客戶名來自 LINE,不可信輸入,一律 textContent) */
function renderCurrent() {
  el.currentBody.textContent = '';
  if (!currentChat) {
    el.currentBody.textContent = currentHint;
    return;
  }
  const nameDiv = document.createElement('div');
  nameDiv.className = 'cur-name';
  nameDiv.textContent = currentChat.name || currentChat.chatId;
  nameDiv.title = currentChat.chatId;
  el.currentBody.appendChild(nameDiv);

  if (inWatchlist(currentChat.chatId)) {
    const mark = document.createElement('span');
    mark.className = 'in-list';
    mark.textContent = '✓ 已在同步清單';
    el.currentBody.appendChild(mark);
  } else {
    const btn = document.createElement('button');
    btn.id = 'add-current';
    btn.textContent = '➕ 將此客戶加入同步';
    btn.addEventListener('click', () => {
      if (!currentChat || inWatchlist(currentChat.chatId)) return;
      saveWatchlist(watchlist.concat([{
        chatId: currentChat.chatId,
        name: currentChat.name || '',
        addedAt: Date.now(),
      }]));
    });
    el.currentBody.appendChild(btn);
  }
}

/** 「同步清單 (N)」區塊:每項顯示名字 + 「立即同步」(單客戶)+ 「移除」 */
function renderWatchlist() {
  el.watchlistTitle.textContent = `同步清單 (${watchlist.length})`;
  el.watchlistList.textContent = '';
  el.watchlistEmpty.style.display = watchlist.length === 0 ? 'block' : 'none';

  for (const w of watchlist) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'wl-name';
    name.textContent = w.name || w.chatId;
    name.title = w.chatId;
    li.appendChild(name);

    const syncBtn = document.createElement('button');
    syncBtn.className = 'mini-btn';
    syncBtn.textContent = '立即同步';
    syncBtn.addEventListener('click', () => {
      syncBtn.disabled = true;
      chrome.runtime.sendMessage({ type: 'lineoaSync_syncNow', chatId: w.chatId }, (resp) => {
        if (chrome.runtime.lastError) {
          render({ lastResult: 'error', lastError: chrome.runtime.lastError.message });
        } else if (resp && !resp.ok && resp.error) {
          // 觸發失敗(例如未開啟 LINE 分頁),狀態已由 background 寫入 storage
          load();
        }
        syncBtn.disabled = false;
      });
    });
    li.appendChild(syncBtn);

    const rmBtn = document.createElement('button');
    rmBtn.className = 'mini-btn ghost';
    rmBtn.textContent = '移除';
    rmBtn.addEventListener('click', () => {
      saveWatchlist(watchlist.filter((x) => x.chatId !== w.chatId));
    });
    li.appendChild(rmBtn);

    el.watchlistList.appendChild(li);
  }
}

/** 偵測活躍分頁是否為 chat.line.biz 客戶聊天室;是則向 content script 取 {chatId, name} */
function detectCurrentChat() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    const url = (tab && tab.url) || '';
    const isChatPage = /^https:\/\/chat\.line\.biz\/[^/]+\/chat\/[^/?#]+/.test(url);
    if (!tab || typeof tab.id !== 'number' || !isChatPage) {
      currentChat = null;
      currentHint = '請在 chat.line.biz 開啟客戶聊天室';
      renderCurrent();
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'lineoaSync_getCurrentChat' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        // content script 未載入(例如安裝插件前就開著的分頁)
        currentChat = null;
        currentHint = 'LINE 分頁尚未載入同步腳本,請重新整理該分頁';
      } else if (!resp.ok || !resp.chatId) {
        currentChat = null;
        currentHint = '請在 chat.line.biz 開啟客戶聊天室';
      } else {
        currentChat = { botId: resp.botId || null, chatId: resp.chatId, name: resp.name || null };
      }
      renderCurrent();
    });
  });
}

// ------------------------------------------------ 載入與變更監聽

function load() {
  chrome.storage.local.get([STATUS_KEY, SKIPPED_FILES_KEY, WATCHLIST_KEY], (data) => {
    render(data[STATUS_KEY]);
    renderSkipped(data[SKIPPED_FILES_KEY]);
    watchlist = sanitizeWatchlist(data[WATCHLIST_KEY]);
    renderWatchlist();
    renderCurrent();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STATUS_KEY]) render(changes[STATUS_KEY].newValue);
  if (changes[SKIPPED_FILES_KEY]) renderSkipped(changes[SKIPPED_FILES_KEY].newValue);
  if (changes[WATCHLIST_KEY]) {
    watchlist = sanitizeWatchlist(changes[WATCHLIST_KEY].newValue);
    renderWatchlist();
    renderCurrent(); // 「✓ 已在同步清單」狀態跟著清單變
  }
});

el.syncBtn.addEventListener('click', () => {
  el.syncBtn.disabled = true;
  el.syncBtn.textContent = '啟動中…';
  chrome.runtime.sendMessage({ type: 'lineoaSync_syncNow' }, (resp) => {
    if (chrome.runtime.lastError) {
      render({ lastResult: 'error', lastError: chrome.runtime.lastError.message });
      return;
    }
    if (resp && !resp.ok && resp.error) {
      // 觸發失敗(例如未開啟 LINE 分頁),狀態已由 background 寫入 storage
      load();
    }
    // 成功啟動後,進度由 storage.onChanged 即時更新
  });
});

el.openOptions.addEventListener('click', (e) => {
  e.preventDefault();
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('options.html'));
  }
});

load();
detectCurrentChat();
