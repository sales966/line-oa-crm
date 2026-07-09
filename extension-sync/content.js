/**
 * 清晨沙灘 LINE 同步器 — content script
 * 注入 https://chat.line.biz/*,以已登入 session 呼叫 LINE 內部 API,
 * 並把資料推送到本地後端(CONTRACT.md「Extension 同步流程——白名單模式」8 步:
 * 讀 watchlist → missing-files 兜底 → 逐個抓白名單客戶 → 增量新訊息
 * → 按需建檔(sync-requests)→ 常規缺檔下載 → 記事本 → 寫入狀態)。
 * 核心原則:只同步使用者挑選的客戶(watchlist),絕不全量掃描聊天列表;
 * watchlist 為空時跳過 1-4 步,但仍處理 sync-requests(webui 建檔)與 missing-files。
 *
 * 觸發(CONTRACT「同步觸發規則」):
 * - 定時整輪:background 'lineoaSync_hourly' alarm(受 10–22 時窗限制,handler 在 background)
 * - 輕量心跳:background 每 1 分鐘發 'lineoaSync_lightTick' → runLightTick 只查後端
 *   sync-requests + 遺留 pendingFiles,無事可做立即返回,絕不主動碰 LINE 聊天 API
 * - 新對話偵測:MutationObserver 監看左側聊天列表,變化 debounce 後只同步該客戶
 *   (解析不出 chatId 時退而對整個 watchlist 增量一輪),不受時窗限制
 * - 人工:popup「立即同步」與頁內浮動按鈕「⟳ 同步」,不受時窗限制
 *
 * 與後端的通訊一律先經由 background service worker 轉送
 * (避免 https 頁面對 http://localhost 的 CORS / Private Network Access 限制),
 * 轉送失敗時退回 content script 直接 fetch。
 *
 * 所有 storage key / 訊息型別皆以 'lineoaSync_' 為前綴,與其他插件互不干擾。
 */
(() => {
  'use strict';

  const STATUS_KEY = 'lineoaSync_status';
  const OPTIONS_KEY = 'lineoaSync_options';
  const PENDING_FILES_KEY = 'lineoaSync_pendingFiles'; // 跨輪待下載檔案佇列(單輪上限 20,下輪繼續)
  const SKIPPED_FILES_KEY = 'lineoaSync_skippedFiles'; // 超限/最終失敗的檔案(popup「跳過的檔案」,不准靜默丟棄)
  const WATCHLIST_KEY = 'lineoaSync_watchlist';        // 白名單:[{chatId, name, addedAt}](popup 讀寫;建檔完成後 content script 也併入)
  const DEFAULT_OPTIONS = { backendUrl: 'http://localhost:4680', extensionToken: '', intervalMinutes: 60, startHour: 10, endHour: 22 };

  const LINE_ORIGIN = 'https://chat.line.biz';
  const CONTENT_ORIGIN = 'https://chat-content.line.biz';

  // 節流(CONTRACT.md):LINE API 請求間隔 >=300ms;檔案下載併發 1、間隔 >=1s、單輪上限 20
  const LINE_REQUEST_INTERVAL_MS = 300;
  const FILE_DOWNLOAD_INTERVAL_MS = 1000;
  const MAX_FILES_PER_ROUND = 20;

  const FIRST_SYNC_MAX_PAGES = 10;      // 首次同步(lastMessageTs 為 null)每 chat 最多翻 10 頁
  const INCREMENTAL_MAX_PAGES = 300;    // 增量同步的安全上限,避免異常時無限翻頁
  const MESSAGE_POST_CHUNK = 200;       // 每次 POST /api/ingest/messages 的訊息上限
  // 檔案大小上限 300MB(CONTRACT:background 直接 blob→FormData 上傳,不經 base64/sendMessage)
  const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
  const MAX_PENDING_ATTEMPTS = 5;       // 待下載檔案最多重試輪數,避免壞檔永久佔佇列
  const DOWNLOAD_SUPPRESS_MS = 6 * 60 * 60 * 1000; // 達重試上限的壞檔短期抑制窗(6 小時內不再重試)
  const MAX_PENDING_STORED = 500;       // 跨輪佇列持久化上限,避免 storage 無限膨脹
  const MAX_SKIPPED_STORED = 200;       // 跳過的檔案清單持久化上限
  const MISSING_FILES_BATCH_LIMIT = 1000; // 建檔缺檔循環拉取的單批上限(後端 limit 上限)
  const HEARTBEAT_INTERVAL_MS = 20000;  // 同步進行中的心跳,background 據此防跨分頁並發派發
  const SYNC_STALE_MS = 2 * 60 * 1000;  // 全域 running 狀態心跳逾時(與 background 一致)

  // 新對話本地偵測(MutationObserver)+ 頁內浮動按鈕
  const DETECT_KNOWN_DEBOUNCE_MS = 15000;    // 解析出 chatId 且在白名單 → 15 秒 debounce → syncOne
  const DETECT_UNKNOWN_DEBOUNCE_MS = 60000;  // 列表有變化但解析不出 chatId → 60 秒 debounce → 整個 watchlist 增量一輪
  const ROUTE_CHECK_INTERVAL_MS = 3000;      // SPA 路由/容器核對週期(等待列表容器出現、重掛 observer、核對浮動按鈕)
  const MUTATION_BATCH_CAP = 30;             // observer 回調單批最多看的 mutation 數(保持極輕)

  let syncing = false;
  let lastLineRequestAt = 0;

  // ---------------------------------------------------------------- 工具

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  async function getOptions() {
    const data = await storageGet([OPTIONS_KEY]);
    const opts = Object.assign({}, DEFAULT_OPTIONS, data[OPTIONS_KEY] || {});
    opts.backendUrl = String(opts.backendUrl || DEFAULT_OPTIONS.backendUrl).replace(/\/+$/, '');
    // 插件認證 Token(options「後端 API Token」= 後端 .env EXTENSION_TOKEN;空 = 過渡模式)
    opts.extensionToken = typeof opts.extensionToken === 'string' ? opts.extensionToken.trim() : '';
    return opts;
  }

  /**
   * 合併寫入同步狀態(popup 讀取顯示;background 據 running+heartbeatAt 防並發派發)。
   * 以 promise 鏈串行化:心跳計時器與主流程的 read-modify-write 若交錯,
   * 後寫者會用舊快照蓋掉先寫者的欄位(例如 running:false 被心跳洗回 true)。
   */
  let statusWriteChain = Promise.resolve();
  function mergeStatus(patch) {
    statusWriteChain = statusWriteChain.then(async () => {
      try {
        const data = await storageGet([STATUS_KEY]);
        const cur = data[STATUS_KEY] || {};
        await storageSet({ [STATUS_KEY]: Object.assign({}, cur, patch) });
      } catch (e) {
        // storage 失敗不影響同步本身
        console.warn('[lineoaSync] 寫入狀態失敗', e);
      }
    });
    return statusWriteChain;
  }

  /** 讀取上輪未下載完的待下載檔案佇列(CONTRACT:單輪上限 20,下輪繼續) */
  async function loadPendingFiles() {
    try {
      const data = await storageGet([PENDING_FILES_KEY]);
      const list = data[PENDING_FILES_KEY];
      return Array.isArray(list) ? list.filter((f) => f && f.chatId && f.contentHash) : [];
    } catch (e) {
      return [];
    }
  }

  /** 持久化本輪未下載完的待下載檔案佇列(下載成功者不在其中,即視為移除) */
  async function savePendingFiles(list) {
    try {
      await storageSet({ [PENDING_FILES_KEY]: (list || []).slice(0, MAX_PENDING_STORED) });
    } catch (e) {
      console.warn('[lineoaSync] 寫入待下載佇列失敗', e);
    }
  }

  // ------------------------------------------------ 跳過的檔案(CONTRACT:不准靜默丟棄)

  async function loadSkippedFiles() {
    try {
      const data = await storageGet([SKIPPED_FILES_KEY]);
      return Array.isArray(data[SKIPPED_FILES_KEY]) ? data[SKIPPED_FILES_KEY] : [];
    } catch (e) {
      return [];
    }
  }

  /** 記錄超限或最終下載失敗的檔案(含原因),popup 顯示「跳過的檔案」清單 */
  async function addSkippedFile(entry) {
    try {
      const list = await loadSkippedFiles();
      const filtered = list.filter((f) => f && f.contentHash !== entry.contentHash);
      filtered.unshift(Object.assign({ at: Date.now() }, entry));
      await storageSet({ [SKIPPED_FILES_KEY]: filtered.slice(0, MAX_SKIPPED_STORED) });
    } catch (e) {
      console.warn('[lineoaSync] 寫入跳過檔案清單失敗', e);
    }
  }

  /**
   * 讀取白名單:[{chatId, name, addedAt}]。
   * popup 讀寫;content script 平時只讀,唯一寫入時機是按需建檔完成後
   * 經 addToWatchlist 併入該客戶(見 processSyncRequests)。
   */
  async function loadWatchlist() {
    try {
      const data = await storageGet([WATCHLIST_KEY]);
      const list = data[WATCHLIST_KEY];
      return Array.isArray(list) ? list.filter((w) => w && typeof w.chatId === 'string' && w.chatId) : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * 把客戶併入白名單(webui 按需建檔完成後呼叫):增量同步(runSync 步驟 3-4)
   * 只遍歷 watchlist,建檔的客戶若不併入,之後的新訊息永遠不會被增量同步,
   * webui 該客戶頁面會停在建檔當下;backend 無法寫插件 storage,只能由此補上。
   * 以 promise 鏈串行化(同 mergeStatus),寫入前重讀最新清單(read-modify-write),
   * 降低與 popup 併發寫入的覆蓋風險(建檔跑在 alarm 輪時 popup 通常未開)。
   * 已在清單中則不動(保留原 name/addedAt);失敗只 console.warn,不影響建檔結果。
   * popup 監聽 storage.onChanged,寫入後會自動重繪清單。
   */
  let watchlistWriteChain = Promise.resolve();
  function addToWatchlist(chatId, name) {
    watchlistWriteChain = watchlistWriteChain.then(async () => {
      try {
        const list = await loadWatchlist();
        if (list.some((w) => w.chatId === chatId)) return;
        list.push({ chatId, name: name || '', addedAt: Date.now() });
        await storageSet({ [WATCHLIST_KEY]: list });
      } catch (e) {
        console.warn('[lineoaSync] 併入白名單失敗', chatId, e);
      }
    });
    return watchlistWriteChain;
  }

  /** 檔案事後下載成功時,自跳過清單移除 */
  async function removeSkippedFile(contentHash) {
    try {
      const list = await loadSkippedFiles();
      const filtered = list.filter((f) => f && f.contentHash !== contentHash);
      if (filtered.length !== list.length) {
        await storageSet({ [SKIPPED_FILES_KEY]: filtered });
      }
    } catch (e) {
      // 清單維護失敗不影響同步
    }
  }

  function oversizeReason(bytes) {
    return `檔案過大(${(bytes / 1048576).toFixed(1)} MB,超過 ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB 上限)`;
  }

  /** LINE API 401/403(登入失效)判斷 */
  function isAuthError(e) {
    return !!(e && e.authError);
  }

  /** 從目前網址解析 botId(https://chat.line.biz/{botId}/chat/{chatId}) */
  function getBotId() {
    const m = location.pathname.match(/^\/([^/]+)/);
    if (!m) return null;
    const seg = decodeURIComponent(m[1]);
    // botId 為 LINE 的 U 開頭識別碼(U + 32 位十六進位),採白名單格式校驗:
    // 停留在設定頁/錯誤頁等其他路徑時回 null,避免把功能路徑誤當 botId
    // 而對 LINE API 發出一串 404 垃圾請求。
    return /^U[0-9a-f]{32}$/i.test(seg) ? seg : null;
  }

  /** 從目前網址解析 chatId(https://chat.line.biz/{botId}/chat/{chatId});非聊天頁回 null */
  function getChatIdFromUrl() {
    const m = location.pathname.match(/^\/[^/]+\/chat\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** LINE 內部 API fetch(同源、附 cookie、全域節流 >=300ms) */
  async function lineFetch(pathOrUrl) {
    const wait = lastLineRequestAt + LINE_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastLineRequestAt = Date.now();

    const url = pathOrUrl.startsWith('http') ? pathOrUrl : LINE_ORIGIN + pathOrUrl;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      const err = new Error(`LINE API ${res.status} (${pathOrUrl})`);
      err.status = res.status;
      // 401/403 = LINE 登入失效(CONTRACT「登入偵測」):標 authError,呼叫端中止並標 needLogin
      if (res.status === 401 || res.status === 403) err.authError = true;
      throw err;
    }
    return res.json();
  }

  // ------------------------------------------------------- 後端通訊(經 background 轉送)

  function sendToBackground(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
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

  /**
   * 插件認證(CONTRACT「帳號與認證」):組裝發往後端的 headers。
   * token 非空時附 X-Extension-Token;空 = 過渡模式,不帶該 header。
   * (background 轉送路徑由 background.js 自行讀 options 附加,此處只服務直接 fetch 後備)
   */
  function withTokenHeader(headers, token) {
    const h = Object.assign({}, headers || {});
    if (token) h['X-Extension-Token'] = token;
    return h;
  }

  /**
   * 依後端回應狀態維護 status.tokenError(popup 紅字「API Token 錯誤,請檢查插件設定」):
   * 401 且已設 token → tokenError:true;2xx → 清除(token 修正後下一次成功請求自動復原)。
   * 以本分頁快取避免每個請求都寫 storage;與 needLogin(LINE 登入失效)互不影響、可並存。
   */
  let tokenErrorFlag = null;
  function noteBackendAuth(status, token) {
    let flag = null;
    if (status === 401 && token) flag = true;
    else if (typeof status === 'number' && status >= 200 && status < 300) flag = false;
    if (flag === null || flag === tokenErrorFlag) return;
    tokenErrorFlag = flag;
    mergeStatus({ tokenError: flag });
  }

  /** POST JSON 到後端;優先 background 轉送(token 由 background 附加),失敗時直接 fetch */
  async function backendPost(backendUrl, path, jsonBody) {
    const url = backendUrl + path;
    const token = (await getOptions()).extensionToken;
    let resp = null;
    try {
      resp = await sendToBackground({ type: 'lineoaSync_backendRequest', url, method: 'POST', json: jsonBody });
    } catch (e) {
      resp = null; // background 不可用,改走直接 fetch
    }
    if (resp && typeof resp === 'object' && 'ok' in resp) {
      noteBackendAuth(resp.status, token);
      if (!resp.ok) throw new Error(`後端 ${resp.status || ''} ${path}${resp.error ? ' — ' + resp.error : ''}`);
      return resp.data || {};
    }
    // 後備:直接 fetch(後端需允許 CORS 時才會成功)
    const res = await fetch(url, {
      method: 'POST',
      headers: withTokenHeader({ 'Content-Type': 'application/json' }, token),
      body: JSON.stringify(jsonBody),
    });
    noteBackendAuth(res.status, token);
    if (!res.ok) throw new Error(`後端 ${res.status} ${path}`);
    return res.json().catch(() => ({}));
  }

  /** GET 後端 JSON;優先 background 轉送(token 由 background 附加),失敗時直接 fetch */
  async function backendGet(backendUrl, path) {
    const url = backendUrl + path;
    const token = (await getOptions()).extensionToken;
    let resp = null;
    try {
      resp = await sendToBackground({ type: 'lineoaSync_backendRequest', url, method: 'GET' });
    } catch (e) {
      resp = null; // background 不可用,改走直接 fetch
    }
    if (resp && typeof resp === 'object' && 'ok' in resp) {
      noteBackendAuth(resp.status, token);
      if (!resp.ok) throw new Error(`後端 ${resp.status || ''} ${path}${resp.error ? ' — ' + resp.error : ''}`);
      return resp.data || {};
    }
    const res = await fetch(url, { method: 'GET', headers: withTokenHeader({}, token) });
    noteBackendAuth(res.status, token);
    if (!res.ok) throw new Error(`後端 ${res.status} ${path}`);
    return res.json().catch(() => ({}));
  }

  /**
   * 上傳檔案到後端 POST /api/ingest/file(multipart/form-data)。
   * 僅供 background 不可用時的後備路徑:content script 直接 fetch(可能受 CORS 限制)。
   * 正常路徑由 background 的 lineoaSync_lineDownload 一氣呵成
   * (blob→FormData 直傳,不經 base64/sendMessage,支援到 300MB)。
   */
  async function backendUploadFile(backendUrl, fields, blob) {
    const url = backendUrl + '/api/ingest/file';
    const token = (await getOptions()).extensionToken;
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) fd.append(k, String(v));
    }
    fd.append('file', blob, fields.fileName || 'file');
    // token 非空時帶 X-Extension-Token(multipart boundary 由瀏覽器自動附加,不可自設 Content-Type)
    const res = await fetch(url, { method: 'POST', headers: withTokenHeader({}, token), body: fd });
    noteBackendAuth(res.status, token);
    if (!res.ok) throw new Error(`後端 ${res.status} /api/ingest/file`);
    return res.json().catch(() => ({}));
  }

  // ------------------------------------------------------- LINE 資料抓取

  /**
   * 步驟 3(白名單模式):抓「單一」chat 的最新 profile/狀態
   * GET /api/v1/bots/{botId}/chats/{chatId}(同源、含 profile.name/done/followedUp/
   * lastReceivedAt/updatedAt/chatType;節流 >=300ms 由 lineFetch 保證)。
   * 取代舊的 listAllChats 全量掃描——絕不翻整個聊天列表。
   */
  async function fetchSingleChat(botId, chatId) {
    const data = await lineFetch(
      `/api/v1/bots/${encodeURIComponent(botId)}/chats/${encodeURIComponent(chatId)}`
    );
    const c = data && typeof data === 'object' ? data : {};
    // 回應可能不含 chatId 欄位,以請求的 chatId 兜底
    return mapChat(Object.assign({}, c, { chatId: c.chatId || c.id || chatId }));
  }

  /** 把 LINE chat 物件映射為 CONTRACT 的 ingest 形狀 */
  function mapChat(c) {
    return {
      chatId: c.chatId || c.id || null,
      // 無名時回 null(不可用 ''):後端 upsert 以 COALESCE 只在 NULL 時保留舊名,
      // 空字串會把庫中既有客戶名覆蓋成空串(webui 顯示「(未命名)」)
      name: (c.profile && c.profile.name) || c.name || c.chatName || null,
      chatType: c.chatType || null,
      done: c.done === true,
      followedUp: c.followedUp === true,
      lastReceivedAt: typeof c.lastReceivedAt === 'number' ? c.lastReceivedAt : null,
      updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : null,
    };
  }

  /**
   * 步驟 4:抓單一 chat 的「增量」訊息(backward 游標向歷史翻頁)。
   * 增量:翻到本頁最舊 timestamp <= lastMessageTs 即停;
   * 首次(lastMessageTs 為 null):最多翻 FIRST_SYNC_MAX_PAGES 頁。
   * 完整歷史不在此處做,由「按需建檔」(backfillChatFully)負責。
   */
  async function fetchChatEvents(botId, chatId, lastMessageTs) {
    const isFirst = lastMessageTs === null || lastMessageTs === undefined;
    const maxPages = isFirst ? FIRST_SYNC_MAX_PAGES : INCREMENTAL_MAX_PAGES;
    const events = [];
    let backward = null;

    for (let page = 0; page < maxPages; page++) {
      let path = `/api/v3/bots/${encodeURIComponent(botId)}/chats/${encodeURIComponent(chatId)}/messages?limit=100`;
      if (backward) path += `&backward=${encodeURIComponent(backward)}`;
      const data = await lineFetch(path);
      const list = Array.isArray(data.list) ? data.list : Array.isArray(data.messages) ? data.messages : [];
      if (list.length === 0) break;
      events.push(...list);

      if (!isFirst) {
        let oldest = Infinity;
        for (const ev of list) {
          if (typeof ev.timestamp === 'number' && ev.timestamp < oldest) oldest = ev.timestamp;
        }
        if (oldest <= lastMessageTs) break; // 已翻到上次同步點
      }
      backward = data.backward || null;
      if (!backward) break; // 無更早歷史
    }
    return events;
  }

  /**
   * 取得聊天室成員對照 userId→name(群聊 C 開頭 chatId 尤其重要——多位成員要分清誰說的):
   * GET /api/v1/bots/{botId}/chats/{chatId}/members → {list:[{userId,name,iconHash}]}
   * (2026-07-09 實測;每 chat 每輪同步取一次,節流 >=300ms 由 lineFetch 保證)。
   * 失敗不中斷同步(CONTRACT「發送者」):回空對照,senderName 落為 null。
   */
  async function fetchChatMembers(botId, chatId) {
    const map = Object.create(null);
    try {
      const data = await lineFetch(
        `/api/v1/bots/${encodeURIComponent(botId)}/chats/${encodeURIComponent(chatId)}/members`
      );
      const list = Array.isArray(data && data.list) ? data.list : [];
      for (const m of list) {
        if (m && typeof m.userId === 'string' && m.userId && typeof m.name === 'string' && m.name) {
          map[m.userId] = m.name;
        }
      }
    } catch (e) {
      // 成員端點失敗(404/登入失效/網路)不影響訊息同步本身,名字為 null
      console.warn('[lineoaSync] 取得聊天室成員失敗(senderName 將為 null)', chatId, (e && e.message) || e);
    }
    return map;
  }

  /**
   * 把 LINE 訊息事件映射為 CONTRACT 的 ingest 形狀。
   * 跳過無 message 的事件(chatRead 等)。
   * 事件型別(2026-07-09 實測更正):messageSent(我方)| message(客戶/其他成員),
   * 沒有 messageReceived 這種型別;eventType 照實存(ev.type 原樣入庫)。
   * direction 權威規則:source.userId === botId → 'out',否則 'in'(比事件型別更可靠);
   * 無 source.userId 時以事件型別 fallback:messageSent→out、message(及其他)→in。
   * 發送者:每條訊息帶 senderUserId(source.userId)與 senderName(memberNames 對照;
   * 查不到且為單人聊天(chatId 非 C 開頭)的 in 訊息以 fallbackName(chat profile.name)兜底,
   * 仍查不到則 null)。
   */
  function mapEvents(events, lastMessageTs, chatId, ctx) {
    const botId = ctx && ctx.botId ? ctx.botId : null;
    const memberNames = (ctx && ctx.memberNames) || null;
    const fallbackName = (ctx && typeof ctx.fallbackName === 'string' && ctx.fallbackName) || null;
    const isGroupChat = typeof chatId === 'string' && /^C/i.test(chatId);
    const out = [];
    for (const ev of events) {
      if (!ev || !ev.message) continue;
      const ts = typeof ev.timestamp === 'number' ? ev.timestamp : null;
      if (ts === null) continue;
      // 增量時只送比同步點新的訊息(減少流量)。
      // 用嚴格小於:ts === lastMessageTs 的訊息重發,由後端 INSERT OR IGNORE 冪等吸收,
      // 避免同毫秒邊界訊息因游標已前移而永久漏採。
      if (lastMessageTs !== null && lastMessageTs !== undefined && ts < lastMessageTs) continue;
      const m = ev.message;

      const senderUserId =
        ev.source && typeof ev.source.userId === 'string' && ev.source.userId
          ? ev.source.userId
          : null;
      // direction 權威規則:source.userId === botId → out,否則 in;無 source 時退回事件型別
      const direction =
        senderUserId && botId
          ? senderUserId === botId ? 'out' : 'in'
          : ev.type === 'messageSent' ? 'out' : 'in';
      let senderName = senderUserId && memberNames ? memberNames[senderUserId] || null : null;
      if (!senderName && direction === 'in' && !isGroupChat && fallbackName) {
        senderName = fallbackName; // 單人聊天:對方就是這個客戶,用 chat profile.name 兜底
      }

      out.push({
        // 兜底 id 摻入 chatId:messages.lineMessageId 為全庫 UNIQUE,
        // 不含 chatId 時不同 chat 同毫秒同類型的無 id 訊息會互相碰撞、被靜默丟棄
        lineMessageId: String(m.id || ev.id || `${chatId}_${ts}_${m.type || 'unknown'}`),
        eventType: ev.type,
        direction,
        senderUserId,
        senderName,
        msgType: m.type || null,
        text: typeof m.text === 'string' ? m.text : undefined,
        contentHash: m.contentHash || undefined,
        fileName: m.fileName || undefined,
        fileSize: typeof m.fileSize === 'number' ? m.fileSize : undefined,
        expiredAt: typeof m.expiredAt === 'number' ? m.expiredAt : undefined,
        // 貼圖:LINE 訊息含 stickerId/packageId,webui 以此組 LINE CDN 圖片 1:1 還原
        stickerId: m.stickerId || (m.sticker && m.sticker.stickerId) || undefined,
        packageId: m.packageId || (m.sticker && m.sticker.packageId) || undefined,
        timestamp: ts,
        raw: ev,
      });
    }
    // 由舊到新排序,讓後端 sync_state 的 lastMessageTs 單調遞增
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }

  /** 步驟 7(及按需建檔):抓記事本 */
  async function fetchNotes(botId, chatId) {
    const data = await lineFetch(
      `/api/v1/bots/${encodeURIComponent(botId)}/chats/${encodeURIComponent(chatId)}/notes?limit=20&withTotal=true`
    );
    const list = Array.isArray(data.list) ? data.list : Array.isArray(data.notes) ? data.notes : [];
    return list
      .map((n) => ({
        lineNoteId: String(n.noteId || n.id || ''),
        body: typeof n.body === 'string' ? n.body : typeof n.text === 'string' ? n.text : '',
        createdAt: typeof n.createdAt === 'number' ? n.createdAt : null,
        updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : null,
      }))
      .filter((n) => n.lineNoteId);
  }

  /**
   * 步驟 6(及按需建檔):下載檔案原檔(裸 URL,不加 /preview 或 /download)並上傳後端。
   * 優先請 background service worker 代為「下載 + 上傳」一氣呵成:
   * - SW 憑 manifest host_permissions 可跨源 fetch chat-content.line.biz 並攜帶 LINE cookie,
   *   不受頁面(chat.line.biz)CORS 約束;content script 直接 fetch 該域可能被 CORS 攔下。
   * - 下載與上傳都在 SW 內完成,大檔不經 chrome.runtime.sendMessage,避開訊息體積上限。
   * background 不可用時才退回 content script 直接 fetch(可能受 CORS 限制)。
   */
  async function downloadAndUploadFile(backendUrl, botId, item) {
    const url = `${CONTENT_ORIGIN}/bot/${encodeURIComponent(botId)}/${encodeURIComponent(item.contentHash)}`;
    const fields = {
      chatId: item.chatId,
      lineMessageId: item.lineMessageId || '',
      contentHash: item.contentHash,
      fileName: item.fileName || item.contentHash,
      expiredAt: typeof item.expiredAt === 'number' ? item.expiredAt : undefined,
      mimeType: item.mimeType || undefined,
    };

    let resp = null;
    try {
      resp = await sendToBackground({ type: 'lineoaSync_lineDownload', url, backendUrl, fields });
    } catch (e) {
      resp = null; // background 不可用,退回 content script 直接下載
    }
    if (resp && typeof resp === 'object' && 'ok' in resp) {
      // 上傳階段的狀態碼來自後端(成功 = 2xx;stage:'upload' = 後端拒收):
      // 據此維護 tokenError(401 + 已設 token);下載階段狀態碼屬 LINE,不參與判斷
      if (resp.ok || resp.stage === 'upload') {
        noteBackendAuth(resp.status, (await getOptions()).extensionToken);
      }
      if (!resp.ok) {
        const err = new Error(resp.error || `下載/上傳失敗 HTTP ${resp.status || ''}`);
        err.status = resp.status;
        // 下載階段 401/403 = LINE 登入失效;超限由 background 回報 TOO_LARGE
        if (resp.stage === 'download' && (resp.status === 401 || resp.status === 403)) err.authError = true;
        if (resp.code === 'TOO_LARGE') err.tooLarge = true;
        throw err;
      }
      return resp.data || {};
    }

    // 後備:content script 直接 fetch(受頁面 CORS 約束,可能失敗)
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      const err = new Error(`下載檔案 ${res.status} (${item.fileName || item.contentHash})`);
      err.status = res.status;
      if (res.status === 401 || res.status === 403) err.authError = true;
      throw err;
    }
    const blob = await res.blob();
    if (blob.size > MAX_UPLOAD_BYTES) {
      const err = new Error(`${oversizeReason(blob.size)}(${item.fileName || item.contentHash}),已跳過`);
      err.tooLarge = true;
      throw err;
    }
    const uploadFields = Object.assign({}, fields, {
      fileSize: blob.size,
      mimeType: blob.type || item.mimeType || 'application/octet-stream',
    });
    return backendUploadFile(backendUrl, uploadFields, blob);
  }

  /** 解析 GET /api/ingest/missing-files 回應({files:[...]};相容舊欄位 missingFiles)為下載佇列項目 */
  function parseMissingFiles(resp, botId) {
    const list = Array.isArray(resp && resp.files)
      ? resp.files
      : Array.isArray(resp && resp.missingFiles)
        ? resp.missingFiles
        : [];
    const out = [];
    for (const mf of list) {
      const chatId = (mf && (mf.chatId || mf.lineChatId)) || null;
      if (!mf || !mf.contentHash || !chatId) continue;
      out.push({
        botId,
        chatId,
        contentHash: mf.contentHash,
        fileName: mf.fileName || '',
        lineMessageId: mf.lineMessageId || '',
        fileSize: typeof mf.fileSize === 'number' ? mf.fileSize : undefined,
        expiredAt: typeof mf.expiredAt === 'number' ? mf.expiredAt : undefined,
      });
    }
    return out;
  }

  /**
   * 整理下載佇列:去除已知超限(tooLarge,300MB 上限不會自己變小)與重複 contentHash
   * (保留先出現者,carried 放最前即保留其 attempts 計數)。
   */
  async function dedupeFileQueue(rawQueue) {
    const skippedNow = await loadSkippedFiles();
    const tooLargeHashes = new Set(
      skippedNow.filter((f) => f && f.tooLarge && f.contentHash).map((f) => f.contentHash)
    );
    // 短期抑制:已達重試上限的壞檔在 suppressUntil 之前不再進佇列。
    // 否則後端 missing-files 每輪重新回報(且 serverMissing 項目不帶 attempts,
    // attempts 從 0 重起),MAX_PENDING_ATTEMPTS 的跨輪重試上限形同虛設——
    // 一個持續失敗但後端認為未過期的壞檔會每輪再耗掉最多 5 次 LINE 下載請求,
    // 無限期擠壓單輪 20 個下載預算。抑制窗過後放行一次(重新累積 attempts)。
    const now = Date.now();
    const suppressedHashes = new Set(
      skippedNow
        .filter((f) => f && f.contentHash && !f.tooLarge &&
          typeof f.suppressUntil === 'number' && f.suppressUntil > now)
        .map((f) => f.contentHash)
    );
    const seenHash = new Set();
    return rawQueue.filter((f) => {
      if (!f || !f.contentHash) return false;
      if (tooLargeHashes.has(f.contentHash)) return false;
      if (suppressedHashes.has(f.contentHash)) return false;
      if (seenHash.has(f.contentHash)) return false;
      seenHash.add(f.contentHash);
      return true;
    });
  }

  /**
   * 逐個下載佇列檔案並上傳(runSync 步驟 6 與輕量心跳共用):
   * 併發 1、間隔 >=1s;單輪上限按「嘗試次數」計(失敗的下載也對
   * chat-content.line.biz 發出了請求,必須計入,否則佇列中大量壞檔時
   * 一輪會發出遠超 20 次的下載請求)。queue 需先經 dedupeFileQueue。
   * 回傳 { leftover, authFailed }:leftover 為本輪未完成的項目(持久化到下輪)。
   */
  async function drainFileQueue(backendUrl, defaultBotId, queue, counts, errors) {
    let attemptsThisRound = 0;
    let authFailed = false;
    const leftover = []; // 本輪未完成的項目,持久化到下輪
    for (let i = 0; i < queue.length; i++) {
      if (authFailed || attemptsThisRound >= MAX_FILES_PER_ROUND) {
        leftover.push(...queue.slice(i)); // 超過單輪上限/登入失效,原樣留到下輪
        break;
      }
      const item = queue[i];
      // 已知大小超過 300MB:直接記入跳過清單,不發下載請求
      if (typeof item.fileSize === 'number' && item.fileSize > MAX_UPLOAD_BYTES) {
        await addSkippedFile({
          chatId: item.chatId,
          contentHash: item.contentHash,
          fileName: item.fileName || '',
          tooLarge: true,
          reason: oversizeReason(item.fileSize),
        });
        continue;
      }
      attemptsThisRound++;
      try {
        // 上輪持久化的項目自帶 botId(可能與目前頁面不同 bot)
        await downloadAndUploadFile(backendUrl, item.botId || defaultBotId, item);
        counts.files++;
        await removeSkippedFile(item.contentHash);
      } catch (e) {
        errors.push(`檔案 ${item.fileName || item.contentHash}:${e.message || e}`);
        console.warn('[lineoaSync] 檔案下載/上傳失敗', item.contentHash, item.fileName || '', e);
        if (isAuthError(e)) {
          authFailed = true;
          leftover.push(item); // 登入失效非檔案本身的錯,留到下輪
          continue;
        }
        if (e && e.tooLarge) {
          // 超限:記入跳過清單(popup「跳過的檔案」),不再重試
          await addSkippedFile({
            chatId: item.chatId,
            contentHash: item.contentHash,
            fileName: item.fileName || '',
            tooLarge: true,
            reason: (e && e.message) || String(e),
          });
        } else {
          const attempts = (Number(item.attempts) || 0) + 1;
          if (attempts < MAX_PENDING_ATTEMPTS) {
            leftover.push(Object.assign({}, item, { attempts }));
          } else {
            // 達重試上限 = 最終失敗:記入跳過清單(不准靜默丟棄);
            // 後端 missing-files 兜底仍會重新報告,事後成功會自清單移除。
            // 帶 suppressUntil:短期(6 小時)內 dedupeFileQueue 不再讓它進佇列,
            // 避免後端每輪重報時 attempts 從 0 重起、無限期重試擠壓下載預算。
            await addSkippedFile({
              chatId: item.chatId,
              contentHash: item.contentHash,
              fileName: item.fileName || '',
              suppressUntil: Date.now() + DOWNLOAD_SUPPRESS_MS,
              reason: `多次下載失敗(${(e && e.message) || e})`,
            });
            console.warn('[lineoaSync] 檔案重試達上限,記入跳過清單', item.contentHash, item.fileName || '');
          }
        }
      }
      await sleep(FILE_DOWNLOAD_INTERVAL_MS);
    }
    return { leftover, authFailed };
  }

  // ------------------------------------------------------- 按需建檔(CONTRACT 核心機制)

  /**
   * 把單一 chat 的完整歷史用 backward 游標翻頁到底(無頁數上限,節流 >=300ms 由 lineFetch 保證),
   * 邊翻邊分批 POST /api/ingest/messages,最後一批帶 backfillDone:true(+ oldestReachedTs)。
   * seedBackward(選填)= 後端回傳的已入庫最舊訊息 lineMessageId:
   * 以它為初始 backward 游標「從最舊已知訊息續傳」向歷史翻頁
   * (增量邏輯保證已入庫區間連續,續傳安全),超大 chat 建檔中途失敗留 pending 後,
   * 下輪不必從最新一頁重頭翻整部歷史(重複對 LINE 發數百請求、增加風控風險)。
   * 種子游標被 LINE 拒絕(4xx,例如本地合成的兜底 id)時退回從頭全量翻頁。
   * 401/403 由 lineFetch 拋 authError,由呼叫端中止並標 needLogin。回傳寫入訊息數。
   * fallbackName(選填)= 客戶名,供單人聊天 senderName 兜底(見 mapEvents)。
   */
  async function backfillChatFully(backendUrl, botId, chatId, seedBackward, fallbackName) {
    let backward = typeof seedBackward === 'string' && seedBackward ? seedBackward : null;
    let seedPending = backward !== null; // 僅第一個(種子)請求允許 4xx 降級,之後照舊拋錯
    let oldestReachedTs = null;
    let inserted = 0;
    const buffer = [];
    // 建檔前先取成員對照(每 chat 一次;失敗回空對照,不中斷)
    const memberNames = await fetchChatMembers(botId, chatId);
    const mapCtx = { botId, memberNames, fallbackName: fallbackName || null };

    const postChunk = async (chunk) => {
      const resp = await backendPost(backendUrl, '/api/ingest/messages', { chatId, messages: chunk });
      inserted += typeof resp.inserted === 'number' ? resp.inserted : 0;
    };

    for (;;) {
      let path = `/api/v3/bots/${encodeURIComponent(botId)}/chats/${encodeURIComponent(chatId)}/messages?limit=100`;
      if (backward) path += `&backward=${encodeURIComponent(backward)}`;
      let data;
      try {
        data = await lineFetch(path);
        seedPending = false;
      } catch (e) {
        // 只有「首個請求(種子游標)+ 非登入類 4xx」退回全量翻頁;
        // 其他錯誤(5xx/網路/401/403)照舊往外拋,請求留 pending 下輪重試
        if (seedPending && !isAuthError(e) &&
            typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
          console.warn('[lineoaSync] 建檔續傳游標被拒,退回從頭全量翻頁', chatId, e.message || e);
          seedPending = false;
          backward = null;
          continue;
        }
        throw e;
      }
      const list = Array.isArray(data.list) ? data.list : Array.isArray(data.messages) ? data.messages : [];
      const mapped = mapEvents(list, null, chatId, mapCtx);
      for (const m of mapped) {
        if (oldestReachedTs === null || m.timestamp < oldestReachedTs) oldestReachedTs = m.timestamp;
      }
      buffer.push(...mapped);

      const next = data.backward || null;
      // 游標重複視為到底,防呆避免無限翻頁
      const reachedEnd = list.length === 0 || !next || next === backward;
      // 邊翻邊分批送出,避免長歷史整段囤積在記憶體;最後一批留給 backfillDone
      while (!reachedEnd && buffer.length >= MESSAGE_POST_CHUNK) {
        await postChunk(buffer.splice(0, MESSAGE_POST_CHUNK));
      }
      if (reachedEnd) break;
      backward = next;
    }

    while (buffer.length > MESSAGE_POST_CHUNK) {
      await postChunk(buffer.splice(0, MESSAGE_POST_CHUNK));
    }
    // 最後一批(可為空)帶 backfillDone:true,後端據此標 sync_state.backfillDone=1
    const finalBody = { chatId, messages: buffer.splice(0, buffer.length), backfillDone: true };
    if (oldestReachedTs !== null) finalBody.oldestReachedTs = oldestReachedTs;
    const finalResp = await backendPost(backendUrl, '/api/ingest/messages', finalBody);
    inserted += typeof finalResp.inserted === 'number' ? finalResp.inserted : 0;
    return inserted;
  }

  /**
   * 步驟 5:按需建檔。GET /api/ingest/sync-requests 取得 pending 請求,逐個「串行」處理:
   * 完整歷史回填(最後一批帶 backfillDone:true)
   * → GET missing-files?chatId= 下載該 chat 全部缺檔(不受單輪 20 上限;仍併發 1、間隔 >=1s)
   * → 拉記事本 → POST sync-requests/{chatId}/done {ok:true}
   * → 把該客戶併入 watchlist(否則之後的增量同步永遠不涵蓋它,見 addToWatchlist)。
   * 任一步失敗:POST done {ok:false,error},後端留 pending 下輪重試;
   * 401/403(authError)直接往外拋,由呼叫端標 needLogin 並中止本輪。
   * 進行中清單寫入 status.fullSyncQueue 供 popup 顯示「建檔中的客戶」。
   */
  async function processSyncRequests(opts, botId, nameById, counts, errors, builtHashes) {
    let requests = [];
    try {
      const resp = await backendGet(opts.backendUrl, '/api/ingest/sync-requests');
      requests = Array.isArray(resp.requests) ? resp.requests : [];
    } catch (e) {
      // 後端無此端點(舊版)或查詢失敗:本輪略過按需建檔,不影響其餘步驟
      return;
    }

    let queueView = requests
      .filter((r) => r && r.chatId)
      .map((r) => ({ chatId: r.chatId, name: nameById[r.chatId] || '' }));
    await mergeStatus({ fullSyncQueue: queueView });
    if (queueView.length === 0) return;

    for (const req of requests) {
      const chatId = req && req.chatId;
      if (!chatId) continue;
      try {
        // 0) 順帶取得客戶名:webui 建檔的客戶多半不在 watchlist,nameById 沒有它,
        // 先抓一次 profile 以免稍後併入白名單時空名(失敗無妨,登入失效除外)
        if (!nameById[chatId]) {
          try {
            const c = await fetchSingleChat(botId, chatId);
            if (c.name) nameById[chatId] = c.name;
          } catch (e) {
            if (isAuthError(e)) throw e;
            // 名字抓不到不影響建檔,空名進 watchlist,可於 popup 手動辨識
          }
        }

        // 1) 完整歷史回填到底(oldestLineMessageId = 續傳種子游標,見 backfillChatFully;
        // 客戶名作單人聊天 senderName 兜底)
        counts.messages += await backfillChatFully(
          opts.backendUrl,
          botId,
          chatId,
          typeof req.oldestLineMessageId === 'string' ? req.oldestLineMessageId : null,
          nameById[chatId] || null
        );

        // 2) 下載該 chat 的全部缺檔(CONTRACT:不受單輪 20 個上限約束;仍併發 1、間隔 >=1s)。
        // 單次 GET 後端預設只回 200 筆(上限 1000),長歷史 chat 缺檔可遠超一批:
        // 循環「GET → 逐個下載 → 再 GET」直到清空——成功上傳後 files 表有實體,
        // 下一批查詢自然不再回報。attemptedHashes 記錄本次建檔已嘗試過的 contentHash
        // (含下載失敗與超限跳過):若整批回傳都已嘗試過,表示只剩持續失敗的壞檔,
        // 跳出避免死循環;殘餘缺檔已記入跳過清單,由常規輪 missing-files 兜底繼續重試。
        const attemptedHashes = new Set();
        for (;;) {
          const missResp = await backendGet(
            opts.backendUrl,
            `/api/ingest/missing-files?chatId=${encodeURIComponent(chatId)}&limit=${MISSING_FILES_BATCH_LIMIT}`
          );
          const files = parseMissingFiles(missResp, botId).filter(
            (f) => !attemptedHashes.has(f.contentHash)
          );
          if (files.length === 0) break;
          for (const item of files) {
            attemptedHashes.add(item.contentHash);
            // 已知大小超過 300MB:直接記入跳過清單,不發下載請求
            if (typeof item.fileSize === 'number' && item.fileSize > MAX_UPLOAD_BYTES) {
              await addSkippedFile({
                chatId,
                contentHash: item.contentHash,
                fileName: item.fileName || '',
                tooLarge: true,
                reason: oversizeReason(item.fileSize),
              });
              continue;
            }
            try {
              await downloadAndUploadFile(opts.backendUrl, botId, item);
              counts.files++;
              // 記錄本輪建檔已成功下載的 contentHash:步驟 6 的常規佇列(含步驟 2
              // 建檔前抓的 serverMissing 舊快照)據此濾掉,避免對剛下載完的檔案重發
              // chat-content.line.biz 下載請求、白白消耗單輪 20 個下載預算
              if (builtHashes) builtHashes.add(item.contentHash);
              await removeSkippedFile(item.contentHash);
            } catch (e) {
              if (isAuthError(e)) throw e;
              // 單檔失敗不使整個建檔請求失敗:記入跳過清單(popup 可見),
              // 後端 missing-files 兜底仍會在常規輪持續回報、重試
              errors.push(`建檔檔案 ${item.fileName || item.contentHash}:${e.message || e}`);
              await addSkippedFile({
                chatId,
                contentHash: item.contentHash,
                fileName: item.fileName || '',
                tooLarge: !!(e && e.tooLarge),
                reason: (e && e.message) || String(e),
              });
            }
            await sleep(FILE_DOWNLOAD_INTERVAL_MS);
          }
        }

        // 3) 記事本
        const notes = await fetchNotes(botId, chatId);
        if (notes.length > 0) {
          await backendPost(opts.backendUrl, '/api/ingest/notes', { chatId, notes });
          counts.notes += notes.length;
        }

        // 4) 完成回報(後端標 done,LLM 已配置時自動觸發總結)
        await backendPost(
          opts.backendUrl,
          `/api/ingest/sync-requests/${encodeURIComponent(chatId)}/done`,
          { ok: true }
        );

        // 5) 併入白名單:增量同步只跑 watchlist,不併入的話該客戶
        // 之後的新訊息永遠不會同步,webui 會停在建檔當下(失敗不影響建檔結果)
        await addToWatchlist(chatId, nameById[chatId] || '');

        queueView = queueView.filter((q) => q.chatId !== chatId);
        await mergeStatus({ fullSyncQueue: queueView });
      } catch (e) {
        const msg = (e && e.message) || String(e);
        errors.push(`建檔 ${chatId}:${msg}`);
        console.warn('[lineoaSync] 按需建檔失敗', chatId, e);
        try {
          await backendPost(
            opts.backendUrl,
            `/api/ingest/sync-requests/${encodeURIComponent(chatId)}/done`,
            { ok: false, error: msg }
          );
        } catch (e2) {
          // 回報失敗也無妨:後端本就留 pending,下輪重試
        }
        if (isAuthError(e)) {
          // 登入失效會中止當前及其後所有未處理的建檔請求:先清掉 fullSyncQueue,
          // 否則 popup 在顯示「LINE 登入已失效」的同時仍列著一串「建檔中的客戶」
          // (那些其實已中止、並非在建檔),造成使用者誤解。剩餘請求後端留 pending 下輪重試。
          await mergeStatus({ fullSyncQueue: [] });
          throw e; // 中止剩餘請求,交由呼叫端標 needLogin
        }
      }
    }
  }

  // ------------------------------------------------------- 主同步流程

  /**
   * 主同步流程。onlyChatId(選填)= popup「立即同步此客戶」:
   * 只同步該客戶(missing-files 兜底也只查該 chat),並略過按需建檔階段。
   */
  async function runSync(trigger, onlyChatId) {
    if (syncing) return { ok: false, error: '同步進行中' };
    syncing = true;

    const counts = { chats: 0, messages: 0, files: 0, notes: 0 };
    const errors = [];
    let pendingFiles = 0;
    let authFailed = false; // LINE API 回 401/403(登入失效)

    await mergeStatus({
      running: true,
      lastStartAt: Date.now(),
      heartbeatAt: Date.now(),
      lastTrigger: trigger || 'unknown',
      lastError: null,
    });
    // 心跳:background triggerSync 派發前檢查 running + heartbeatAt,
    // 防止建檔長時間執行(可遠超 alarm 週期)時在其他分頁啟動第二輪並發同步;
    // 分頁崩潰時心跳停止,逾時後 background 視為殘留、恢復派發
    const heartbeatTimer = setInterval(() => {
      mergeStatus({ heartbeatAt: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);

    try {
      const opts = await getOptions();
      const botId = getBotId();
      if (!botId) throw new Error('無法從網址解析 botId,請開啟 https://chat.line.biz/{botId}/ 頁面');

      // 步驟 1:讀 watchlist(白名單模式:只同步使用者挑選的客戶)。
      // onlyChatId(立即同步此客戶)= 只取該客戶;不在清單時仍照常同步一次。
      const watchlist = await loadWatchlist();
      let targets = watchlist;
      if (onlyChatId) {
        targets = watchlist.filter((w) => w.chatId === onlyChatId);
        if (targets.length === 0) targets = [{ chatId: onlyChatId, name: '' }];
      }

      // 步驟 2:每輪開始先向後端取 missing-files(缺檔的權威兜底),
      // 稍後與本地跨輪佇列、本輪增量產生的缺檔合併去重。
      // watchlist 為空時仍要處理(CONTRACT:空清單只跳過 1-4 步)。
      // 後端未實作(舊版 404)或查詢失敗時靜默略過,行為退回本地佇列。
      let serverMissing = [];
      try {
        const missPath = onlyChatId
          ? `/api/ingest/missing-files?chatId=${encodeURIComponent(onlyChatId)}`
          : '/api/ingest/missing-files';
        const missResp = await backendGet(opts.backendUrl, missPath);
        serverMissing = parseMissingFiles(missResp, botId);
      } catch (e) {
        // 不影響本輪
      }

      // 步驟 3:逐個 fetchSingleChat(節流 >=300ms 由 lineFetch 保證)→ 整批 POST /api/ingest/chats。
      // 單個 404/失敗跳過並記入 errors(popup 可見),不中斷整輪;絕不全量掃描聊天列表。
      const chats = [];
      for (const w of targets) {
        try {
          const c = await fetchSingleChat(botId, w.chatId);
          if (c.chatId) chats.push(c);
        } catch (e) {
          errors.push(`客戶 ${w.name || w.chatId}:${e.message || e}`);
          console.warn('[lineoaSync] 取得客戶資料失敗,跳過', w.chatId, e);
          if (isAuthError(e)) {
            authFailed = true;
            break; // 登入失效:後續客戶全會失敗,直接中止
          }
        }
      }
      counts.chats = chats.length;
      let syncStates = {};
      if (chats.length > 0) {
        const chatsResp = await backendPost(opts.backendUrl, '/api/ingest/chats', { chats });
        syncStates = (chatsResp && chatsResp.syncStates) || {};
      }

      // 步驟 4:對有新訊息的 chat 增量拉訊息(首次每 chat 上限 10 頁,完整歷史靠按需建檔)
      const fileQueue = []; // 後端回報缺檔的下載佇列
      const syncedChats = []; // 本輪有處理的 chat(之後拉 notes)

      for (const chat of chats) {
        if (authFailed) break;
        try {
          // syncStates 值為 {lastMessageTs, oldestMessageTs, backfillDone}(CONTRACT);
          // 相容舊後端直接回數字的形狀
          const st = Object.prototype.hasOwnProperty.call(syncStates, chat.chatId)
            ? syncStates[chat.chatId]
            : null;
          const lastTs = st && typeof st === 'object'
            ? (typeof st.lastMessageTs === 'number' ? st.lastMessageTs : null)
            : (typeof st === 'number' ? st : null);
          const isFirst = lastTs === null || lastTs === undefined;
          // 增量條件:lastReceivedAt > lastMessageTs;首次一律同步
          if (!isFirst && !(typeof chat.lastReceivedAt === 'number' && chat.lastReceivedAt > lastTs)) {
            continue;
          }
          syncedChats.push(chat);

          // 同步此 chat 前先取成員對照(每 chat 每輪一次;失敗回空對照不中斷,senderName 為 null)
          const memberNames = await fetchChatMembers(botId, chat.chatId);
          const events = await fetchChatEvents(botId, chat.chatId, isFirst ? null : lastTs);
          const messages = mapEvents(events, isFirst ? null : lastTs, chat.chatId, {
            botId,
            memberNames,
            fallbackName: chat.name || null, // 單人聊天 senderName 兜底(chat profile.name)
          });

          // 記錄檔案中繼資料,補齊 missingFiles 缺少的 fileSize/expiredAt
          const metaByHash = {};
          for (const msg of messages) {
            if (msg.contentHash) {
              metaByHash[msg.contentHash] = {
                fileSize: msg.fileSize,
                expiredAt: msg.expiredAt,
                fileName: msg.fileName,
                lineMessageId: msg.lineMessageId,
              };
            }
          }

          // 分批 POST /api/ingest/messages
          for (let i = 0; i < messages.length; i += MESSAGE_POST_CHUNK) {
            const chunk = messages.slice(i, i + MESSAGE_POST_CHUNK);
            const resp = await backendPost(opts.backendUrl, '/api/ingest/messages', {
              chatId: chat.chatId,
              messages: chunk,
            });
            counts.messages += typeof resp.inserted === 'number' ? resp.inserted : chunk.length;
            const missing = Array.isArray(resp.missingFiles) ? resp.missingFiles : [];
            for (const mf of missing) {
              if (!mf || !mf.contentHash) continue;
              const meta = metaByHash[mf.contentHash] || {};
              fileQueue.push({
                botId,
                chatId: chat.chatId,
                contentHash: mf.contentHash,
                fileName: mf.fileName || meta.fileName || '',
                lineMessageId: mf.lineMessageId || meta.lineMessageId || '',
                fileSize: typeof meta.fileSize === 'number' ? meta.fileSize : undefined,
                expiredAt: meta.expiredAt,
              });
            }
          }
        } catch (e) {
          errors.push(`聊天 ${chat.chatId}:${e.message || e}`);
          console.warn('[lineoaSync] 聊天同步失敗', chat.chatId, e);
          if (isAuthError(e)) {
            authFailed = true;
            break; // 登入失效:後續 chat 全會失敗,直接中止
          }
        }
      }

      // 步驟 5:按需建檔(核心機制,取代全面歷史回填):
      // webui 按「建檔」→ backend sync_requests → 此處完整拉歷史 + 全部缺檔 + notes → done。
      // watchlist 為空也要處理(webui 建檔不依賴白名單);onlyChatId(單客戶同步)時略過,
      // 建檔耗時長,交由定時整輪處理,避免「立即同步此客戶」被拖住。
      // 本輪按需建檔階段已成功下載的 contentHash(供步驟 6 濾除,避免重複下載)
      const builtHashes = new Set();
      if (!authFailed && !onlyChatId) {
        try {
          const nameById = {};
          for (const w of watchlist) nameById[w.chatId] = w.name || '';
          for (const c of chats) if (c.name) nameById[c.chatId] = c.name;
          await processSyncRequests(opts, botId, nameById, counts, errors, builtHashes);
        } catch (e) {
          if (isAuthError(e)) {
            authFailed = true;
          } else {
            errors.push(`按需建檔:${e.message || e}`);
            console.warn('[lineoaSync] 按需建檔階段失敗', e);
          }
        }
      }

      // 步驟 6:下載常規缺檔並上傳(併發 1、間隔 >=1s、單輪上限 20,其餘下輪繼續)
      // 「下輪繼續」:併入上輪持久化的待下載佇列(chrome.storage.local),
      // 本輪沒下載完/失敗的項目再寫回去,即使該 chat 下輪沒有新訊息也會被補下載。
      // carried 放最前,去重時保留其 attempts 計數;serverMissing 為步驟 2 取得的權威兜底;
      // 已知超限(tooLarge)的檔案不再進佇列重試,其餘跳過的檔案仍可經
      // missing-files 兜底重試,成功後自跳過清單移除(dedupeFileQueue)。
      const carried = await loadPendingFiles();
      // 濾掉本輪建檔階段已下載完成的 contentHash:serverMissing 是步驟 2(建檔前)
      // 的舊快照,對那些檔案再發下載請求只會白白消耗單輪 20 個預算(後端 contentHash
      // UNIQUE 會忽略重傳)。builtHashes 為空(onlyChatId / 無 pending 建檔)時等同不過濾。
      const rawQueue = carried
        .concat(fileQueue, serverMissing)
        .filter((f) => f && f.contentHash && !builtHashes.has(f.contentHash));
      const uniqueQueue = await dedupeFileQueue(rawQueue);
      let leftover;
      if (authFailed) {
        leftover = uniqueQueue; // 登入失效:整批原樣留到下輪
      } else {
        const drained = await drainFileQueue(opts.backendUrl, botId, uniqueQueue, counts, errors);
        leftover = drained.leftover;
        if (drained.authFailed) authFailed = true;
      }
      pendingFiles = leftover.length;
      await savePendingFiles(leftover);

      // 步驟 7:對本輪增量處理過的 chat 拉記事本
      for (const chat of syncedChats) {
        if (authFailed) break;
        try {
          const notes = await fetchNotes(botId, chat.chatId);
          if (notes.length > 0) {
            await backendPost(opts.backendUrl, '/api/ingest/notes', { chatId: chat.chatId, notes });
            counts.notes += notes.length;
          }
        } catch (e) {
          errors.push(`記事本 ${chat.chatId}:${e.message || e}`);
          console.warn('[lineoaSync] 記事本同步失敗', chat.chatId, e);
          if (isAuthError(e)) {
            authFailed = true;
            break;
          }
        }
      }

      // 步驟 8:寫入同步結果供 popup 顯示(needLogin:登入偵測;無 401/403 的一輪會自動清除)
      await mergeStatus({
        running: false,
        lastSyncAt: Date.now(),
        lastResult: errors.length === 0 ? 'ok' : authFailed ? 'error' : 'partial',
        lastError: errors.length > 0 ? errors.slice(0, 5).join('\n') : null,
        counts,
        pendingFiles,
        needLogin: authFailed,
      });
      // 24x7 無人值守:popup 只顯示前 5 條錯誤,完整清單與每輪摘要輸出到 console 供事後排障
      console.info('[lineoaSync] 本輪同步完成', { trigger, counts, pendingFiles, errorCount: errors.length });
      if (errors.length > 0) console.warn('[lineoaSync] 本輪錯誤清單', errors);
      return { ok: true, counts, errors };
    } catch (e) {
      // 後端不可達等整體失敗:記錄後等下一輪重試
      const msg = (e && e.message) || String(e);
      console.warn('[lineoaSync] 本輪同步整體失敗', { trigger, counts }, e);
      const patch = {
        running: false,
        lastResult: 'error',
        lastError: msg,
        lastAttemptAt: Date.now(),
        counts,
        pendingFiles,
      };
      // 401/403 = 登入失效:標 needLogin(popup 醒目顯示);
      // 其他錯誤不動 needLogin,避免後端不可達把登入提示洗掉
      if (isAuthError(e) || authFailed) patch.needLogin = true;
      await mergeStatus(patch);
      return { ok: false, error: msg };
    } finally {
      clearInterval(heartbeatTimer);
      syncing = false;
    }
  }

  // ------------------------------------------------------- 輕量心跳(每 1 分鐘,background 派發)

  /**
   * 輕量模式(lineoaSync_lightTick):只查後端 sync-requests(localhost),
   * 有 pending 建檔請求才執行建檔流程(這會抓 LINE,但只有 webui 明確要求才會有 pending),
   * 順帶處理上輪遺留的 pendingFiles 下載;無 pending 且無遺留時立即返回,
   * 不寫 lastSyncAt/lastResult 等狀態(避免 popup 把每分鐘心跳誤顯示成一輪完整同步)。
   * 絕不主動碰 LINE 聊天 API(列表/訊息/記事本只在建檔流程內發生)。
   */
  async function runLightTick() {
    if (syncing) return { ok: false, error: '同步進行中' };

    const opts = await getOptions();
    // 探測:只 GET 後端(localhost),後端不可達則靜默等下一分鐘
    let requests = [];
    try {
      const resp = await backendGet(opts.backendUrl, '/api/ingest/sync-requests');
      requests = (Array.isArray(resp.requests) ? resp.requests : []).filter((r) => r && r.chatId);
    } catch (e) {
      requests = [];
    }
    const carried = await loadPendingFiles();
    if (requests.length === 0 && carried.length === 0) {
      return { ok: true, idle: true }; // 無事可做:立即返回,不寫任何狀態
    }

    if (syncing) return { ok: false, error: '同步進行中' }; // 探測期間可能已有同步啟動
    syncing = true;
    const counts = { chats: 0, messages: 0, files: 0, notes: 0 };
    const errors = [];
    let authFailed = false;
    // 有工作才標 running + 心跳(background 據此不再派發整輪);不動 lastStartAt/lastTrigger
    await mergeStatus({ running: true, heartbeatAt: Date.now() });
    const heartbeatTimer = setInterval(() => {
      mergeStatus({ heartbeatAt: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);

    try {
      const botId = getBotId();

      // 1) pending 建檔請求(processSyncRequests 自己會再 GET sync-requests 取最新清單)
      if (requests.length > 0) {
        if (!botId) {
          console.warn('[lineoaSync] 輕量心跳:無法從網址解析 botId,建檔請求暫緩');
        } else {
          const watchlist = await loadWatchlist();
          const nameById = {};
          for (const w of watchlist) nameById[w.chatId] = w.name || '';
          await processSyncRequests(opts, botId, nameById, counts, errors);
        }
      }

      // 2) 上輪遺留的 pendingFiles(單輪上限 20,項目自帶 botId)
      if (carried.length > 0) {
        const queue = await dedupeFileQueue(carried);
        const drained = await drainFileQueue(opts.backendUrl, botId, queue, counts, errors);
        if (drained.authFailed) authFailed = true;
        await savePendingFiles(drained.leftover);
        await mergeStatus({ pendingFiles: drained.leftover.length });
      }
    } catch (e) {
      errors.push((e && e.message) || String(e));
      console.warn('[lineoaSync] 輕量心跳處理失敗', e);
      if (isAuthError(e)) authFailed = true;
    } finally {
      clearInterval(heartbeatTimer);
      syncing = false;
      // 只收回 running;authFailed 才標 needLogin(成功不清除,交由整輪同步判定)
      const patch = { running: false };
      if (authFailed) patch.needLogin = true;
      await mergeStatus(patch);
    }
    if (errors.length > 0) console.warn('[lineoaSync] 輕量心跳錯誤清單', errors);
    return { ok: errors.length === 0, counts, errors };
  }

  // ------------------------------------------------------- 新對話本地偵測(MutationObserver)

  // observer 回調只把線索記入以下 pending 集合(絕不做同步操作),debounce 到期才動工
  const pendingDetectedIds = new Set();
  let pendingUnknownChange = false;
  let knownDebounceTimer = null;
  let unknownDebounceTimer = null;
  let chatListObserver = null;
  let observedContainer = null;

  /** 讀全域同步狀態,判斷是否有分頁正在同步(同 background 派發前的防並發檢查) */
  async function isGloballySyncing() {
    try {
      const data = await storageGet([STATUS_KEY]);
      const st = data[STATUS_KEY] || {};
      const beat = Math.max(Number(st.heartbeatAt) || 0, Number(st.lastStartAt) || 0);
      return st.running === true && Date.now() - beat < SYNC_STALE_MS;
    } catch (e) {
      return false;
    }
  }

  /**
   * 從變動節點向上/向內找含 chatId 的線索:
   * 最近的 a[href*='/chat/'](變動常發生在連結內部的文字/未讀徽章)或 data 屬性。
   * 解析不出回 null(由呼叫端記 pendingUnknownChange)。
   */
  function extractChatIdFromNode(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el) return null;
    let anchor = null;
    if (typeof el.closest === 'function') anchor = el.closest('a[href*="/chat/"]');
    if (!anchor && typeof el.querySelector === 'function') anchor = el.querySelector('a[href*="/chat/"]');
    const href = anchor && anchor.getAttribute('href');
    if (href) {
      const m = href.match(/\/chat\/([^/?#]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    // 備援:data 屬性(LINE DOM 改版時的線索)
    const dataEl = typeof el.closest === 'function' ? el.closest('[data-chat-id],[data-chatid]') : null;
    if (dataEl) {
      const v = dataEl.getAttribute('data-chat-id') || dataEl.getAttribute('data-chatid');
      if (v) return v;
    }
    return null;
  }

  /** observer 回調:必須極輕——只解析 chatId 記入 pending 集合並排 debounce */
  function onChatListMutations(mutations) {
    if (!mutations || mutations.length === 0) return;
    let parsedAny = false;
    const cap = Math.min(mutations.length, MUTATION_BATCH_CAP); // 極端大量變動時只看前段,保持輕量
    for (let i = 0; i < cap; i++) {
      const m = mutations[i];
      const candidates = [m.target];
      if (m.addedNodes) for (const n of m.addedNodes) candidates.push(n);
      for (const n of candidates) {
        const chatId = extractChatIdFromNode(n);
        if (chatId) {
          pendingDetectedIds.add(chatId);
          parsedAny = true;
        }
      }
    }
    if (parsedAny) {
      scheduleKnownFlush();
    } else {
      // 列表確有變化但解析不出 chatId → 60 秒 debounce → 整個 watchlist 增量一輪
      pendingUnknownChange = true;
      scheduleUnknownFlush();
    }
  }

  function scheduleKnownFlush() {
    if (knownDebounceTimer) clearTimeout(knownDebounceTimer);
    knownDebounceTimer = setTimeout(() => {
      knownDebounceTimer = null;
      flushDetectedIds().catch((e) => console.warn('[lineoaSync] 新對話偵測同步失敗', e));
    }, DETECT_KNOWN_DEBOUNCE_MS);
  }

  function scheduleUnknownFlush() {
    if (unknownDebounceTimer) clearTimeout(unknownDebounceTimer);
    unknownDebounceTimer = setTimeout(() => {
      unknownDebounceTimer = null;
      flushUnknownChange().catch((e) => console.warn('[lineoaSync] 新對話偵測整輪同步失敗', e));
    }, DETECT_UNKNOWN_DEBOUNCE_MS);
  }

  /** 15 秒 debounce 到期:對 pending 中屬於白名單的 chatId 逐個 syncOne(不在白名單者忽略) */
  async function flushDetectedIds() {
    if (pendingDetectedIds.size === 0) return;
    if (syncing || (await isGloballySyncing())) {
      scheduleKnownFlush(); // 有同步在跑:保留 pending,整批延後再試
      return;
    }
    const watchlist = await loadWatchlist();
    const watchedIds = new Set(watchlist.map((w) => w.chatId));
    const ids = [];
    for (const id of pendingDetectedIds) if (watchedIds.has(id)) ids.push(id);
    pendingDetectedIds.clear();
    for (const chatId of ids) {
      const r = await runSync('detected', chatId);
      if (r && !r.ok && r.error === '同步進行中') {
        pendingDetectedIds.add(chatId); // 撞上其他分頁的同步:留回 pending 下次再試
      }
    }
    if (pendingDetectedIds.size > 0) scheduleKnownFlush();
  }

  /** 60 秒 debounce 到期:解析不出 chatId 的變化 → 對整個 watchlist 增量一輪(仍只查 watchlist) */
  async function flushUnknownChange() {
    if (!pendingUnknownChange) return;
    if (syncing || (await isGloballySyncing())) {
      scheduleUnknownFlush();
      return;
    }
    pendingUnknownChange = false;
    const r = await runSync('detected');
    if (r && !r.ok && r.error === '同步進行中') {
      pendingUnknownChange = true;
      scheduleUnknownFlush();
    }
  }

  /** 尋找左側聊天列表容器:以第一個 chat 連結為錨,向上找包含多個 chat 連結的祖先 */
  function findChatListContainer() {
    const link = document.querySelector('a[href*="/chat/"]');
    if (!link) return null;
    let el = link.parentElement;
    for (let depth = 0; el && el !== document.body && depth < 10; depth++) {
      if (el.querySelectorAll('a[href*="/chat/"]').length >= 2) return el;
      el = el.parentElement;
    }
    return link.parentElement; // 只有一個聊天時退回連結的直接父層
  }

  /**
   * 掛載/重掛 MutationObserver:啟動時容器可能尚未渲染(SPA),
   * 由 ROUTE_CHECK_INTERVAL_MS 的定期核對輪詢等待;路由變化重建容器時也在此重掛。
   * 只觀察聊天列表容器,不監聽/不修改頁面其他元素(CONTRACT)。
   */
  function mountChatListObserver() {
    const container = findChatListContainer();
    if (!container || container === observedContainer) return;
    if (chatListObserver) chatListObserver.disconnect();
    observedContainer = container;
    chatListObserver = new MutationObserver(onChatListMutations);
    chatListObserver.observe(container, { childList: true, subtree: true, characterData: true });
    console.info('[lineoaSync] 已掛載聊天列表觀察器');
  }

  // ------------------------------------------------------- 頁內浮動按鈕(/chat/{chatId} 限定)

  const FAB_ID = 'lineoa-sync-fab';
  let fabSyncBusy = false;
  let fabResetTimer = null;

  /** 設定按鈕標籤(一律 textContent,不用 innerHTML);spin=true 時圖示套轉圈動畫 */
  function setFabLabel(btn, icon, text, spin) {
    btn.textContent = '';
    const iconSpan = document.createElement('span');
    iconSpan.textContent = icon;
    if (spin) iconSpan.className = 'lineoa-sync-spin';
    btn.appendChild(iconSpan);
    btn.appendChild(document.createTextNode(' ' + text));
  }

  /**
   * 建立左下角胶囊按鈕(公司報價助手佔右下,嚴禁擺右下;z-index 低於 2147483000,
   * 不遮 LINE 輸入區)。樣式全部內聯,僅轉圈動畫需要 @keyframes,注入自帶的
   * <style>(id 前綴 lineoa-sync-,不引任何外部資源)。重複呼叫回傳既有元素。
   */
  function buildFab() {
    let root = document.getElementById(FAB_ID);
    if (root) return root;

    if (!document.getElementById('lineoa-sync-fab-style')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'lineoa-sync-fab-style';
      styleEl.textContent =
        '@keyframes lineoa-sync-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}' +
        '#lineoa-sync-fab .lineoa-sync-spin{display:inline-block;animation:lineoa-sync-spin 1s linear infinite}';
      (document.head || document.documentElement).appendChild(styleEl);
    }

    root = document.createElement('div');
    root.id = FAB_ID;
    root.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:2147482000;display:none;gap:6px;' +
      'font-family:"Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif;';

    const mkBtn = (id, title) => {
      const b = document.createElement('button');
      b.id = id;
      b.type = 'button';
      b.title = title;
      b.style.cssText =
        'padding:6px 14px;border:1px solid #1a5c4a;border-radius:999px;background:#1a5c4a;' +
        'color:#fff;font-size:12px;line-height:1;cursor:pointer;' +
        'box-shadow:0 2px 6px rgba(0,0,0,.25);opacity:.92;';
      return b;
    };
    const syncBtn = mkBtn('lineoa-sync-btn-sync', '同步此客戶到後台(不在白名單會先自動加入)');
    setFabLabel(syncBtn, '⟳', '同步', false);
    const openBtn = mkBtn('lineoa-sync-btn-open', '在後台開啟此客戶頁面');
    openBtn.style.background = '#fff';
    openBtn.style.color = '#1a5c4a';
    setFabLabel(openBtn, '⧉', '後台', false);

    syncBtn.addEventListener('click', () => {
      onFabSyncClick().catch((e) => console.warn('[lineoaSync] 頁內同步失敗', e));
    });
    openBtn.addEventListener('click', () => {
      onFabOpenClick().catch((e) => console.warn('[lineoaSync] 開啟後台失敗', e));
    });

    root.appendChild(syncBtn);
    root.appendChild(openBtn);
    (document.body || document.documentElement).appendChild(root);
    return root;
  }

  /** 依目前 URL 顯示/隱藏浮動按鈕(SPA 重繪把節點清掉時重新掛回) */
  function updateFloatingButtons() {
    const root = buildFab();
    if (!root.isConnected && document.body) document.body.appendChild(root);
    root.style.display = getChatIdFromUrl() ? 'flex' : 'none';
  }

  /** 「⟳ 同步」:不在 watchlist 先自動加入 → syncOne;執行中轉圈、成功打勾 2 秒、失敗打叉;
   *  進入前先過本分頁 syncing 鎖 + 跨分頁 isGloballySyncing 鎖(有同步在跑顯示「同步進行中」2 秒) */
  async function onFabSyncClick() {
    if (fabSyncBusy) return;
    const chatId = getChatIdFromUrl();
    const botId = getBotId();
    const btn = document.getElementById('lineoa-sync-btn-sync');
    if (!chatId || !botId || !btn) return;

    fabSyncBusy = true;
    if (fabResetTimer) {
      clearTimeout(fabResetTimer);
      fabResetTimer = null;
    }
    btn.disabled = true;
    btn.style.opacity = '.7';

    // 跨分頁 in-flight 鎖(與 flushDetectedIds / background 派發路徑一致):
    // 另一分頁的建檔/整輪可長時間執行,此時啟動第二輪會讓兩分頁各自 300ms
    // 節流疊加(對 LINE 合計間隔可低至 ~150ms),違反 CONTRACT(風控風險)
    if (syncing || (await isGloballySyncing())) {
      setFabLabel(btn, '✗', '同步進行中', false);
      fabResetTimer = setTimeout(() => {
        setFabLabel(btn, '⟳', '同步', false);
        btn.disabled = false;
        btn.style.opacity = '.92';
        fabSyncBusy = false;
        fabResetTimer = null;
      }, 2000);
      return;
    }

    setFabLabel(btn, '⟳', '同步中', true);

    let ok = false;
    try {
      // 不在白名單先自動加入(客戶名盡力抓,失敗以空名加入,可於 popup 手動辨識)
      const watchlist = await loadWatchlist();
      if (!watchlist.some((w) => w.chatId === chatId)) {
        let name = '';
        try {
          const c = await fetchSingleChat(botId, chatId);
          name = c.name || '';
        } catch (e) {
          if (isAuthError(e)) mergeStatus({ needLogin: true });
        }
        await addToWatchlist(chatId, name);
      }
      const r = await runSync('pageButton', chatId);
      ok = !!(r && r.ok);
    } catch (e) {
      console.warn('[lineoaSync] 頁內同步失敗', e);
    }

    setFabLabel(btn, ok ? '✓' : '✗', ok ? '完成' : '失敗', false);
    fabResetTimer = setTimeout(() => {
      setFabLabel(btn, '⟳', '同步', false);
      btn.disabled = false;
      btn.style.opacity = '.92';
      fabSyncBusy = false;
      fabResetTimer = null;
    }, 2000);
  }

  /** 「⧉ 後台」:在後台開啟此客戶頁面 */
  async function onFabOpenClick() {
    const chatId = getChatIdFromUrl();
    if (!chatId) return;
    const opts = await getOptions();
    window.open(opts.backendUrl + '/customer.html?chatId=' + encodeURIComponent(chatId));
  }

  // ------------------------------------------------------- 啟動:路由監聽 + 定期核對

  // SPA 路由變化(popstate)即時核對浮動按鈕;定期核對兜底
  // (pushState 不觸發 popstate)並等待/重掛聊天列表觀察器
  window.addEventListener('popstate', () => {
    try {
      updateFloatingButtons();
    } catch (e) {
      // 防禦:核對失敗不影響頁面
    }
  });
  setInterval(() => {
    try {
      if (!observedContainer || !observedContainer.isConnected) {
        observedContainer = null;
        mountChatListObserver();
      }
      updateFloatingButtons();
    } catch (e) {
      // 防禦:核對失敗不影響頁面
    }
  }, ROUTE_CHECK_INTERVAL_MS);
  try {
    mountChatListObserver(); // 啟動先試掛一次(容器未渲染則交由定期核對接手)
    updateFloatingButtons();
  } catch (e) {
    console.warn('[lineoaSync] 初始化偵測/按鈕失敗', e);
  }

  // ------------------------------------------------------- 訊息入口(background alarm / popup)

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;

    // 整輪同步(background alarm / popup「立即同步」)與單客戶同步(popup「立即同步此客戶」)。
    // lineoaSync_sync 亦接受選填 chatId(background 轉發 syncOne 時帶上)。
    if (msg.type === 'lineoaSync_sync' || msg.type === 'lineoaSync_syncOne') {
      const onlyChatId = typeof msg.chatId === 'string' && msg.chatId ? msg.chatId : null;
      if (msg.type === 'lineoaSync_syncOne' && !onlyChatId) {
        sendResponse({ ok: false, error: '缺少 chatId' });
        return undefined;
      }
      // 根頁/帳號選擇頁(content_scripts 照樣注入)解析不出 botId,runSync 必然失敗:
      // 受理前先拒收,讓 background 的逐分頁探詢繼續試下一個 chat.line.biz 分頁,
      // 不讓本分頁吞掉整輪派發(background 對 ok:false 且非「同步進行中」會 continue)
      if (!getBotId()) {
        sendResponse({ ok: false, error: '此分頁無法解析 botId' });
        return undefined;
      }
      if (syncing) {
        sendResponse({ ok: false, error: '同步進行中' });
        return undefined;
      }
      // 立即回覆「已啟動」,實際進度寫入 chrome.storage.local 供 popup 讀取
      sendResponse({ ok: true, started: true });
      runSync(msg.trigger || (onlyChatId ? 'syncOne' : 'message'), onlyChatId).catch((e) => {
        console.warn('[lineoaSync] 同步失敗', e);
      });
      return undefined;
    }

    // 輕量心跳(background 每 1 分鐘):只查後端 sync-requests + 遺留 pendingFiles,
    // 無事可做立即結束;絕不主動碰 LINE 聊天 API(見 runLightTick)
    if (msg.type === 'lineoaSync_lightTick') {
      if (syncing) {
        sendResponse({ ok: false, error: '同步進行中' });
        return undefined;
      }
      sendResponse({ ok: true, started: true });
      runLightTick().catch((e) => console.warn('[lineoaSync] 輕量心跳失敗', e));
      return undefined;
    }

    // popup「目前聊天室」:回目前頁 URL 解析的 {botId, chatId},並抓客戶名。
    // 抓名失敗(404/未登入等)仍回 chatId + name:null,popup 可降級顯示。
    if (msg.type === 'lineoaSync_getCurrentChat') {
      const botId = getBotId();
      const chatId = getChatIdFromUrl();
      if (!botId || !chatId) {
        sendResponse({ ok: false, error: '目前分頁不是客戶聊天室' });
        return undefined;
      }
      fetchSingleChat(botId, chatId)
        .then((c) => sendResponse({ ok: true, botId, chatId, name: c.name || null }))
        .catch((e) => {
          if (isAuthError(e)) mergeStatus({ needLogin: true });
          sendResponse({ ok: true, botId, chatId, name: null });
        });
      return true; // 非同步回覆
    }

    return undefined;
  });

  console.info('[lineoaSync] 清晨沙灘 LINE 同步器 content script 已載入');
})();
