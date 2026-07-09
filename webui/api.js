'use strict';
/**
 * api.js — 同源 /api/* fetch 包裝 + 共用工具
 * 掛在 window.API / window.UI 上,index.html / customer.html / users.html / login.html 共用。
 */
(function (global) {

  // ---------- fetch 包裝 ----------

  /** 是否在登入頁(登入頁自身的 401 不轉跳,避免無窮迴圈) */
  function isLoginPage() {
    return /\/login\.html$/i.test(location.pathname);
  }

  /** 未登入 → 轉跳 login.html,帶 next=目前路徑(登入成功後跳回) */
  function gotoLogin() {
    if (isLoginPage()) return;
    location.href = 'login.html?next=' + encodeURIComponent(location.pathname + location.search);
  }

  // bfcache(back/forward cache)防護:登出後按「返回鍵」瀏覽器會直接還原
  // 整個 DOM 且不重跑 init script,initAuth 的 401 檢查不會執行。
  // 從 bfcache 還原(e.persisted)時重驗 session:401 由 request() 統一轉跳
  // login.html,其他錯誤(離線等)靜默。登入頁自身的還原由 login.html 處理。
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    if (isLoginPage()) return;
    request('/api/auth/me', { method: 'GET' }).catch(function () { /* 401 已轉跳,其他靜默 */ });
  });

  /**
   * 發送請求,自動處理 JSON 與錯誤。
   * 失敗時 throw Error,帶 err.status(0 = 連線失敗)與 err.data(伺服器回的 JSON)。
   * 401 統一轉跳 login.html(登入頁本身除外);options.noAuthRedirect=true 可關閉
   * (登入/改密碼等「401 代表帳密錯」而非「未登入」的請求用)。
   */
  async function request(path, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    opts.headers = Object.assign({ 'Accept': 'application/json' }, opts.headers);
    if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json; charset=utf-8';
      opts.body = JSON.stringify(opts.body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      const err = new Error('無法連線到後端服務,請確認後端程式是否已啟動(連接埠 4680)');
      err.status = 0;
      err.cause = e;
      throw err;
    }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.indexOf('application/json') !== -1) {
      try { data = await res.json(); } catch (e) { /* 非法 JSON,容錯 */ }
    }
    if (!res.ok) {
      if (res.status === 401 && !opts.noAuthRedirect) gotoLogin();
      const msg = (data && (data.error || data.message)) ||
        (res.status === 401 ? '請先登入' : 'HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function get(path) { return request(path, { method: 'GET' }); }
  function post(path, body) { return request(path, { method: 'POST', body: body }); }
  function put(path, body) { return request(path, { method: 'PUT', body: body }); }
  function del(path) { return request(path, { method: 'DELETE' }); }

  // ---------- 階段(stage)對照 ----------
  // 後端權威 5 階段(stageTemplate.ts STAGE_ORDER,由 progressService.computeCurrentStage
  // 寫入 customers.currentStage,一律繁體):洽談 → 已回簽 → 已打樣 → 已出廠 → 已交付;
  // 流失為旁支狀態。此處保留簡體別名僅為容錯(舊資料 / 外部輸入),UI 一律顯示繁體。

  const STAGE_MAP = {
    '洽谈': '洽談', '洽談': '洽談',
    '已回签': '已回簽', '已回簽': '已回簽',
    '已打样': '已打樣', '已打樣': '已打樣',
    '已出厂': '已出廠', '已出廠': '已出廠',
    '已交付': '已交付',
    '流失': '流失'
  };

  const STAGE_CLASS = {
    '洽談': 'stage-talk',
    '已回簽': 'stage-signed',
    '已打樣': 'stage-sample',
    '已出廠': 'stage-shipped',
    '已交付': 'stage-delivered',
    '流失': 'stage-lost'
  };

  // 篩選下拉用:value = 後端實際寫入 customers.currentStage 的繁體字面值(WHERE c.currentStage = ?)
  const STAGE_OPTIONS = [
    { value: '', label: '全部' },
    { value: '洽談', label: '洽談' },
    { value: '已回簽', label: '已回簽' },
    { value: '已打樣', label: '已打樣' },
    { value: '已出廠', label: '已出廠' },
    { value: '已交付', label: '已交付' },
    { value: '流失', label: '流失' }
  ];

  /** 任意寫法 → 繁體顯示名;未知值原樣返回 */
  function stageLabel(stage) {
    if (!stage) return '洽談';
    return STAGE_MAP[String(stage).trim()] || String(stage);
  }

  /** 阶段徽章 HTML(已 escape) */
  function stageBadge(stage) {
    const label = stageLabel(stage);
    const cls = STAGE_CLASS[label] || 'stage-other';
    return '<span class="badge stage ' + cls + '">' + esc(label) + '</span>';
  }

  // ---------- chatType ----------

  const CHAT_TYPE_MAP = { USER: '個人', GROUP: '群組', ROOM: '多人' };

  function chatTypeBadge(chatType) {
    if (!chatType) return '<span class="badge chat-type">未知</span>';
    const key = String(chatType).toUpperCase();
    const label = CHAT_TYPE_MAP[key] || chatType;
    return '<span class="badge chat-type ct-' + esc(key.toLowerCase()) + '">' + esc(label) + '</span>';
  }

  // ---------- 建檔(按需完整同步)狀態 ----------
  // GET /api/customers/:chatId/full-sync → status: none|pending|done|error

  const SYNC_STATUS = {
    none:    { label: '未建檔',  cls: 'sync-none' },
    pending: { label: '建檔中…', cls: 'sync-pending' },
    done:    { label: '已建檔',  cls: 'sync-done' },
    error:   { label: '失敗',    cls: 'sync-error' }
  };

  /** 建檔狀態徽章 HTML;pending 附小 spinner;未知值視同未建檔 */
  function syncBadge(status) {
    const s = SYNC_STATUS[status] || SYNC_STATUS.none;
    const spin = status === 'pending' ? '<span class="spinner tiny"></span>' : '';
    return '<span class="badge sync ' + s.cls + '">' + spin + esc(s.label) + '</span>';
  }

  /** 查詢建檔狀態 → {status, requestedAt?, completedAt?, error?} */
  function getFullSync(chatId) {
    return get('/api/customers/' + encodeURIComponent(chatId) + '/full-sync');
  }

  /** 送出建檔請求(upsert 為 pending) */
  function requestFullSync(chatId) {
    return post('/api/customers/' + encodeURIComponent(chatId) + '/full-sync');
  }

  // ---------- 總覽儀表板(index.html 頂部) ----------
  // GET /api/dashboard/stats → {totalCustomers, byStage:{階段:數量}, followedUpCount, withSummary, buildDone}
  function getDashboardStats() {
    return get('/api/dashboard/stats');
  }
  // GET /api/dashboard/reminders → {reminders:[{lineChatId,customerName,currentStage,kind,dueAt,daysLeft,note}]}
  // 逾期/臨近的待辦(大貨死線/打樣/生產),後端已按急迫度排序(daysLeft 升序)
  function getDashboardReminders() {
    return get('/api/dashboard/reminders');
  }

  // ---------- 團隊內部討論(客戶不可見) ----------
  // GET /api/customers/:chatId/team-messages?after=&limit= → createdAt 升序,after=上次最大 id
  // POST /api/customers/:chatId/team-messages {body}(發言人由後端依 session 決定)

  /** 取內部討論訊息;after 為已取回的最大 id(增量輪詢用),0/空 = 從頭 */
  function getTeamMessages(chatId, after, limit) {
    const params = new URLSearchParams({ limit: String(limit || 100) });
    if (after) params.set('after', String(after));
    return get('/api/customers/' + encodeURIComponent(chatId) + '/team-messages?' + params.toString());
  }

  /** 送出內部討論訊息 → {ok:true, message:{id,authorName,authorRole,body,createdAt}} */
  function postTeamMessage(chatId, msg) {
    return post('/api/customers/' + encodeURIComponent(chatId) + '/team-messages', msg);
  }

  // ---------- 帳號與認證(session cookie;/api/auth/*) ----------

  const TEAM_ROLES = ['跟單', '設計', '客服', '管理'];
  const ROLE_CLASS = { '跟單': 'role-follow', '設計': 'role-design', '客服': 'role-service', '管理': 'role-admin' };

  let currentUser = null; // GET /api/auth/me 取得後快取於記憶體(不落 localStorage)

  /** GET /api/auth/me → 快取並回傳 user;未登入時 request() 已統一轉跳 login */
  async function fetchMe() {
    const data = await get('/api/auth/me');
    currentUser = (data && data.user) || null;
    return currentUser;
  }

  /** 讀取快取身分 → {id, username, name(=displayName), role} | null(需先 fetchMe/initAuth) */
  function getUser() {
    if (!currentUser) return null;
    return {
      id: currentUser.id,
      username: currentUser.username,
      name: currentUser.displayName,
      role: currentUser.role
    };
  }

  /** 登入;401 = 帳密錯(不轉跳,由登入頁自行顯示錯誤) */
  async function login(username, password) {
    const data = await request('/api/auth/login', {
      method: 'POST',
      body: { username: username, password: password },
      noAuthRedirect: true
    });
    currentUser = (data && data.user) || null;
    return currentUser;
  }

  /** 登出後一律回登入頁(session 已失效也照樣轉跳) */
  async function logout() {
    try { await post('/api/auth/logout'); } catch (e) { /* 忽略,總之回登入頁 */ }
    currentUser = null;
    location.href = 'login.html';
  }

  /** 修改自己的密碼;401 = 舊密碼錯(不轉跳,由浮層顯示錯誤) */
  function changePassword(oldPassword, newPassword) {
    return request('/api/auth/password', {
      method: 'PUT',
      body: { oldPassword: oldPassword, newPassword: newPassword },
      noAuthRedirect: true
    });
  }

  /** 角色徽章 HTML(跟單/設計/客服/管理 各配色) */
  function roleBadge(role) {
    const cls = ROLE_CLASS[role] || 'role-other';
    return '<span class="badge role ' + cls + '">' + esc(role || '?') + '</span>';
  }

  // ---------- 右上角使用者 chip + 帳號選單(index / customer / users 共用) ----------

  function hideUserMenu() {
    const menu = document.getElementById('user-menu');
    if (menu) menu.hidden = true;
  }

  function toggleUserMenu() {
    const menu = document.getElementById('user-menu');
    if (menu) menu.hidden = !menu.hidden;
  }

  /** 右上角「👤 displayName(role)」;點開選單:修改密碼 / 使用者管理(管理員)/ 登出 */
  function renderUserChip() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    let wrap = document.getElementById('user-chip-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'user-chip-wrap';
      wrap.className = 'user-chip-wrap';
      wrap.innerHTML =
        '<button type="button" id="user-chip" class="user-chip" title="帳號選單"></button>' +
        '<div class="user-menu" id="user-menu" hidden></div>';
      bar.appendChild(wrap);
      wrap.querySelector('#user-chip').addEventListener('click', function (e) {
        e.stopPropagation(); // 別讓下面的 document click 立即把選單關掉
        toggleUserMenu();
      });
      document.addEventListener('click', hideUserMenu);
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') hideUserMenu();
      });
    }
    const u = getUser();
    wrap.querySelector('#user-chip').textContent = u ? ('👤 ' + u.name + '(' + u.role + ')') : '👤 未登入';
    const menu = wrap.querySelector('#user-menu');
    // 問題回報:在客戶頁(customer.html?chatId=)時帶上 chatId,回報自動關聯該客戶
    const chatId = /\/customer\.html$/i.test(location.pathname) ? qsParam('chatId') : '';
    const issuesHref = 'issues.html' + (chatId ? ('?chatId=' + encodeURIComponent(chatId)) : '');
    menu.innerHTML =
      (u && u.role === '管理' ? '<a class="user-menu-item" href="users.html">使用者管理</a>' : '') +
      '<a class="user-menu-item" href="help.html">📖 使用說明</a>' +
      '<a class="user-menu-item" href="' + esc(issuesHref) + '">🐞 問題回報</a>' +
      '<button type="button" class="user-menu-item" data-act="password">修改密碼</button>' +
      '<button type="button" class="user-menu-item danger" data-act="logout">登出</button>';
    menu.querySelector('[data-act="password"]').addEventListener('click', function () {
      hideUserMenu();
      showPasswordModal();
    });
    menu.querySelector('[data-act="logout"]').addEventListener('click', function () {
      hideUserMenu();
      logout();
    });
  }

  /** 修改密碼浮層(PUT /api/auth/password) */
  function showPasswordModal() {
    if (document.getElementById('pw-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'pw-overlay';
    overlay.className = 'modal-overlay';
    const card = document.createElement('div');
    card.className = 'modal-card';
    card.innerHTML =
      '<h2>修改密碼</h2>' +
      '<label for="pw-old">舊密碼</label>' +
      '<input id="pw-old" type="password" autocomplete="current-password">' +
      '<label for="pw-new">新密碼</label>' +
      '<input id="pw-new" type="password" autocomplete="new-password">' +
      '<label for="pw-new2">確認新密碼</label>' +
      '<input id="pw-new2" type="password" autocomplete="new-password">' +
      '<div class="modal-err" id="pw-err"></div>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn" id="pw-cancel">取消</button>' +
      '<button type="button" class="btn primary" id="pw-ok">確定</button>' +
      '</div>';
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const errBox = card.querySelector('#pw-err');
    const okBtn = card.querySelector('#pw-ok');
    function close() { overlay.remove(); }

    async function submit() {
      const oldPw = card.querySelector('#pw-old').value;
      const newPw = card.querySelector('#pw-new').value;
      const newPw2 = card.querySelector('#pw-new2').value;
      if (!oldPw) { errBox.textContent = '請輸入舊密碼'; return; }
      if (newPw.length < 6) { errBox.textContent = '新密碼至少 6 個字元'; return; }
      if (newPw !== newPw2) { errBox.textContent = '兩次輸入的新密碼不一致'; return; }
      errBox.textContent = '';
      okBtn.disabled = true;
      try {
        await changePassword(oldPw, newPw);
        close();
        alert('密碼已更新');
      } catch (e) {
        errBox.textContent = e.status === 401 ? '舊密碼錯誤' : ('修改失敗:' + e.message);
        okBtn.disabled = false;
      }
    }
    okBtn.addEventListener('click', submit);
    card.querySelector('#pw-cancel').addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        if (e.isComposing || e.keyCode === 229) return; // 輸入法選字中
        e.preventDefault();
        submit();
      }
    });
    card.querySelector('#pw-old').focus();
  }

  /**
   * 頁面啟動時呼叫:GET /api/auth/me 確認登入並掛右上角使用者 chip。
   * 回傳 user;未登入(401)回 null 且 request() 已轉跳 login.html;
   * 後端無法連線等其他錯誤也回 null(不轉跳,由頁面自行顯示錯誤)。
   */
  async function initAuth() {
    try {
      await fetchMe();
    } catch (e) {
      return null;
    }
    renderUserChip();
    renderBell();
    return getUser();
  }

  // ---------- 進度表(階段任務紅綠燈 + 天數/物流參數) ----------
  // 皆走 session;寫操作後端統一記 audit。回傳形狀見 CONTRACT「進度表」。

  /** GET /progress → {currentStage, stageOverride, meta, stages:[{stage,tasks}], expected} */
  function getProgress(chatId) {
    return get('/api/customers/' + encodeURIComponent(chatId) + '/progress');
  }
  /** PUT 單一任務紅綠燈(切後後端標 source='manual') → {ok, task} */
  // evidence 省略 → 只改 done(保留既有證據);傳字串(含空)→ 人工補/改證據
  function putTask(chatId, taskKey, done, evidence) {
    var body = { done: done ? 1 : 0 };
    if (evidence !== undefined) body.evidence = evidence;
    return put(
      '/api/customers/' + encodeURIComponent(chatId) + '/progress/task/' + encodeURIComponent(taskKey),
      body
    );
  }
  /** PUT 階段參數(天數/物流/手動鎖定階段;只送要改的欄位) → {ok, progress} */
  function putMeta(chatId, patch) {
    return put('/api/customers/' + encodeURIComponent(chatId) + '/progress/meta', patch);
  }

  // ---------- 訂單(一客戶多張訂單,各自為一段日期範圍的對話切片) ----------
  // 訂單進度走隔離端點 /order-progress(order_stage_tasks / order_stage_meta),
  // 帶 orderId;orderId=0(整體視圖)一律走既有 /progress、/summaries、/messages,行為不變。

  function custBase(chatId) { return '/api/customers/' + encodeURIComponent(chatId); }

  /** orderId>0 才帶 orderId 查詢字串;可併入 extra 參數(物件)。回傳 '' 或 '?a=1&orderId=N' */
  function orderQS(orderId, extra) {
    const p = new URLSearchParams();
    if (extra) {
      Object.keys(extra).forEach(function (k) {
        if (extra[k] !== undefined && extra[k] !== null) p.set(k, String(extra[k]));
      });
    }
    const oid = Number(orderId) || 0;
    if (oid > 0) p.set('orderId', String(oid));
    const s = p.toString();
    return s ? ('?' + s) : '';
  }

  /** GET 訂單清單 → {orders:[{id,title,fromDate,toDate,createdByName,...}]}(倒序) */
  function getOrders(chatId) {
    return get(custBase(chatId) + '/orders');
  }
  /** POST 建訂單 body {title?,fromDate,toDate} → {ok,order} */
  function createOrder(chatId, body) {
    return post(custBase(chatId) + '/orders', body);
  }
  /** PUT 編輯訂單 body {title?,fromDate?,toDate?} → {ok,order} */
  function updateOrder(chatId, orderId, patch) {
    return put(custBase(chatId) + '/orders/' + encodeURIComponent(orderId), patch);
  }
  /** DELETE 訂單(連帶其 summaries/stage_tasks/stage_meta;僅管理或建立者) → {ok} */
  function deleteOrder(chatId, orderId) {
    return del(custBase(chatId) + '/orders/' + encodeURIComponent(orderId));
  }

  // ---- 進度:orderId>0 走 /order-progress;0 走既有 /progress(零回歸) ----

  /** GET 進度 → 形狀同 getProgress */
  function getProgressFor(chatId, orderId) {
    const oid = Number(orderId) || 0;
    return oid > 0
      ? get(custBase(chatId) + '/order-progress' + orderQS(oid))
      : getProgress(chatId);
  }
  /** PUT 單一任務紅綠燈(帶 orderId 時打隔離端點) */
  function putTaskFor(chatId, orderId, taskKey, done, evidence) {
    const oid = Number(orderId) || 0;
    if (oid <= 0) return putTask(chatId, taskKey, done, evidence);
    const body = { done: done ? 1 : 0 };
    if (evidence !== undefined) body.evidence = evidence;
    return put(
      custBase(chatId) + '/order-progress/task/' + encodeURIComponent(taskKey) + orderQS(oid),
      body
    );
  }
  /** PUT 階段參數(帶 orderId 時打隔離端點) */
  function putMetaFor(chatId, orderId, patch) {
    const oid = Number(orderId) || 0;
    return oid > 0
      ? put(custBase(chatId) + '/order-progress/meta' + orderQS(oid), patch)
      : putMeta(chatId, patch);
  }

  // ---- 總結 / 訊息 / 產生總結:orderId 併入查詢字串(0 → 不帶,現狀) ----

  /** GET 總結清單(orderId 範圍) → {summaries:[...]} */
  function getSummariesFor(chatId, orderId) {
    return get(custBase(chatId) + '/summaries' + orderQS(orderId));
  }
  /** GET 訊息(orderId 範圍 + keyset 分頁 before/beforeId/limit) → {messages:[...]} */
  function getMessagesFor(chatId, orderId, opts) {
    const extra = {};
    if (opts) {
      if (opts.limit !== undefined && opts.limit !== null) extra.limit = opts.limit;
      if (opts.before !== undefined && opts.before !== null) extra.before = opts.before;
      if (opts.beforeId !== undefined && opts.beforeId !== null) extra.beforeId = opts.beforeId;
    }
    return get(custBase(chatId) + '/messages' + orderQS(orderId, extra));
  }
  /** POST 產生/重生總結(orderId 範圍;force 時帶 force=1) → {summary,cached?} */
  function summarizeFor(chatId, orderId, force) {
    const extra = force ? { force: '1' } : null;
    return post('/api/summarize/' + encodeURIComponent(chatId) + orderQS(orderId, extra));
  }

  // ---------- 檔案上傳(同事;multipart) ----------

  /**
   * 上傳檔案到某客戶檔案牆(source='upload')。
   * 用 XHR 以取得上傳進度;onProgress(ratio 0..1)。回傳 {ok:true, file:{...}}。
   * 401 一律轉跳登入;連線失敗 err.status=0。
   */
  function uploadFile(chatId, file, onProgress) {
    return new Promise(function (resolve, reject) {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/customers/' + encodeURIComponent(chatId) + '/files/upload');
      xhr.responseType = 'json';
      xhr.setRequestHeader('Accept', 'application/json');
      if (xhr.upload && typeof onProgress === 'function') {
        xhr.upload.addEventListener('progress', function (e) {
          if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
        });
      }
      xhr.addEventListener('load', function () {
        const data = xhr.response;
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data || {});
          return;
        }
        if (xhr.status === 401) gotoLogin();
        const err = new Error((data && (data.error || data.message)) || ('HTTP ' + xhr.status));
        err.status = xhr.status;
        err.data = data;
        reject(err);
      });
      xhr.addEventListener('error', function () {
        const err = new Error('無法連線到後端服務,請確認後端程式是否已啟動(連接埠 4680)');
        err.status = 0;
        reject(err);
      });
      const fd = new FormData();
      fd.append('file', file, file.name);
      xhr.send(fd);
    });
  }

  // ---------- @ 提及:自動完成 / 我的通知 ----------

  /** GET mentions/suggest?q= → {users:[{id,displayName,role}], files:[{id,fileName}]} */
  function suggestMentions(chatId, q) {
    return get(
      '/api/customers/' + encodeURIComponent(chatId) + '/mentions/suggest?q=' + encodeURIComponent(q || '')
    );
  }
  /** GET /api/me/mentions?unreadOnly=1 → {mentions:[{id,lineChatId,chatName,snippet,createdAt,readAt}]} */
  function getMyMentions(unreadOnly) {
    return get('/api/me/mentions' + (unreadOnly ? '?unreadOnly=1' : ''));
  }
  /** POST /api/me/mentions/read {ids} → 標記已讀 */
  function readMentions(ids) {
    return post('/api/me/mentions/read', { ids: ids });
  }

  // ---------- AI 總結:人工編輯 / 批注 / 審計 ----------

  /** PUT summary/:id {editedText} → 存人工版;editedText 傳空字串=還原 */
  function editSummary(chatId, summaryId, editedText) {
    return put(
      '/api/customers/' + encodeURIComponent(chatId) + '/summary/' + encodeURIComponent(summaryId),
      { editedText: editedText }
    );
  }
  /** GET summary/:id/annotations → {annotations:[...]} */
  function getAnnotations(chatId, summaryId) {
    return get(
      '/api/customers/' + encodeURIComponent(chatId) + '/summary/' + encodeURIComponent(summaryId) + '/annotations'
    );
  }
  /** POST summary/:id/annotations {body} → {ok, annotation} */
  function addAnnotation(chatId, summaryId, body) {
    return post(
      '/api/customers/' + encodeURIComponent(chatId) + '/summary/' + encodeURIComponent(summaryId) + '/annotations',
      { body: body }
    );
  }
  /** GET /audit → {logs:[{userName,action,target,detail,createdAt}]} 倒序 */
  function getAudit(chatId) {
    return get('/api/customers/' + encodeURIComponent(chatId) + '/audit');
  }

  // ---------- 通知鈴鐺(index / customer / users 頂欄,掛在使用者 chip 旁) ----------
  // 每 30 秒輪詢 GET /api/me/mentions?unreadOnly=1 顯示未讀數;點開列出被 @ 項,
  // 點項標記已讀並跳 customer.html?chatId=&focus=team。

  let bellTimer = null;
  let bellMentions = [];

  function mentionChatId(m) { return m.lineChatId || m.chatId || ''; }
  function mentionChatName(m) { return m.chatName || m.name || m.lineName || '客戶'; }
  function mentionSnippet(m) { return m.snippet || m.body || m.preview || m.text || ''; }

  function hideBellMenu() {
    const menu = document.getElementById('bell-menu');
    if (menu) menu.hidden = true;
  }

  function toggleBellMenu() {
    const menu = document.getElementById('bell-menu');
    if (!menu) return;
    if (menu.hidden) openBellMenu();
    else menu.hidden = true;
  }

  async function openBellMenu() {
    const menu = document.getElementById('bell-menu');
    if (!menu) return;
    menu.hidden = false;
    menu.innerHTML = '<div class="bell-state">載入中…</div>';
    try {
      const data = await getMyMentions(true);
      bellMentions = (data && data.mentions) || [];
    } catch (e) {
      menu.innerHTML = '<div class="bell-state">通知載入失敗</div>';
      return;
    }
    renderBellMenu();
  }

  function renderBellMenu() {
    const menu = document.getElementById('bell-menu');
    if (!menu || menu.hidden) return;
    if (bellMentions.length === 0) {
      menu.innerHTML = '<div class="bell-state">目前沒有未讀通知</div>';
      return;
    }
    let html = '<div class="bell-head">未讀通知(' + bellMentions.length + ')</div>';
    html += bellMentions.map(function (m) {
      return '<button type="button" class="bell-item" data-id="' + esc(String(m.id)) +
        '" data-chatid="' + esc(mentionChatId(m)) + '">' +
        '<div class="bell-item-top">' +
        '<span class="bell-item-chat">' + esc(mentionChatName(m)) + '</span>' +
        '<span class="bell-item-time">' + esc(relTime(m.createdAt)) + '</span></div>' +
        '<div class="bell-item-snip">' + esc(mentionSnippet(m)) + '</div>' +
        '</button>';
    }).join('');
    menu.innerHTML = html;
    Array.prototype.forEach.call(menu.querySelectorAll('.bell-item'), function (btn) {
      btn.addEventListener('click', function () {
        const id = Number(btn.dataset.id);
        const cid = btn.dataset.chatid;
        if (id) readMentions([id]).catch(function () { /* 標記失敗不阻擋跳轉 */ });
        location.href = 'customer.html?chatId=' + encodeURIComponent(cid) + '&focus=team';
      });
    });
  }

  function updateBellCount() {
    const badge = document.getElementById('bell-count');
    if (!badge) return;
    const n = bellMentions.length;
    if (n > 0) {
      badge.hidden = false;
      badge.textContent = n > 99 ? '99+' : String(n);
    } else {
      badge.hidden = true;
      badge.textContent = '';
    }
  }

  async function pollBell() {
    if (document.visibilityState === 'hidden') return;
    try {
      const data = await getMyMentions(true);
      bellMentions = (data && data.mentions) || [];
    } catch (e) {
      return; // 輪詢失敗靜默,下次再試(與其他輪詢一致)
    }
    updateBellCount();
    renderBellMenu(); // 選單開著時同步刷新
  }

  /** 建立鈴鐺並掛入使用者 chip wrap 前緣(冪等) */
  function renderBell() {
    const wrap = document.getElementById('user-chip-wrap');
    if (!wrap || document.getElementById('bell-wrap')) return;
    const bw = document.createElement('div');
    bw.id = 'bell-wrap';
    bw.className = 'bell-wrap';
    bw.innerHTML =
      '<button type="button" id="bell-btn" class="bell-btn" title="通知" aria-label="通知">🔔' +
      '<span class="bell-count" id="bell-count" hidden></span></button>' +
      '<div class="bell-menu" id="bell-menu" hidden></div>';
    wrap.insertBefore(bw, wrap.firstChild);
    bw.querySelector('#bell-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleBellMenu();
    });
    // 點選單內部不關閉(點項自行導頁)
    bw.querySelector('#bell-menu').addEventListener('click', function (e) {
      e.stopPropagation();
    });
    document.addEventListener('click', hideBellMenu);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideBellMenu();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') pollBell();
    });
    pollBell();
    if (!bellTimer) bellTimer = setInterval(pollBell, 30000);
  }

  // ---------- 格式化工具 ----------

  /** HTML escape,所有伺服器文字必經此函式 */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** epoch ms → 相對時間(繁體) */
  function relTime(ts) {
    if (!ts) return '—';
    const diff = Date.now() - Number(ts);
    if (isNaN(diff)) return '—';
    if (diff < 0) return fmtDateTime(ts);
    const m = Math.floor(diff / 60000);
    if (m < 1) return '剛剛';
    if (m < 60) return m + ' 分鐘前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小時前';
    const d = Math.floor(h / 24);
    if (d < 30) return d + ' 天前';
    return fmtDate(ts);
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** epoch ms → YYYY/MM/DD */
  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '—';
    return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
  }

  /** epoch ms → YYYY/MM/DD HH:mm */
  function fmtDateTime(ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '—';
    return fmtDate(ts) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** bytes → 人類可讀 */
  function fmtSize(bytes) {
    const n = Number(bytes);
    if (!n || isNaN(n) || n <= 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  /** 可能是 JSON 字串也可能已是物件 → 物件(失敗回 null) */
  function parseMaybeJson(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return v;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) return null;
      try { return JSON.parse(s); } catch (e) { return null; }
    }
    return null;
  }

  /** 取 URL query 參數 */
  function qsParam(name) {
    return new URLSearchParams(location.search).get(name);
  }

  /** debounce */
  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 300);
    };
  }

  // ---------- 載入 / 空 / 錯誤狀態片段 ----------

  function loadingHtml(text) {
    return '<div class="state-box"><span class="spinner"></span><span>' + esc(text || '載入中…') + '</span></div>';
  }
  function emptyHtml(text) {
    return '<div class="state-box empty">' + esc(text || '尚無資料') + '</div>';
  }
  function errorHtml(text) {
    return '<div class="state-box error">' + esc(text || '載入失敗') + '</div>';
  }

  global.API = {
    request: request, get: get, post: post, put: put,
    getFullSync: getFullSync, requestFullSync: requestFullSync,
    getDashboardStats: getDashboardStats, getDashboardReminders: getDashboardReminders,
    getTeamMessages: getTeamMessages, postTeamMessage: postTeamMessage,
    login: login, logout: logout, fetchMe: fetchMe, getUser: getUser,
    changePassword: changePassword,
    getProgress: getProgress, putTask: putTask, putMeta: putMeta,
    getOrders: getOrders, createOrder: createOrder, updateOrder: updateOrder, deleteOrder: deleteOrder,
    getProgressFor: getProgressFor, putTaskFor: putTaskFor, putMetaFor: putMetaFor,
    getSummariesFor: getSummariesFor, getMessagesFor: getMessagesFor, summarizeFor: summarizeFor,
    uploadFile: uploadFile,
    suggestMentions: suggestMentions, getMyMentions: getMyMentions, readMentions: readMentions,
    editSummary: editSummary, getAnnotations: getAnnotations, addAnnotation: addAnnotation,
    getAudit: getAudit
  };
  global.UI = {
    esc: esc, relTime: relTime, fmtDate: fmtDate, fmtDateTime: fmtDateTime, pad2: pad2,
    fmtSize: fmtSize, parseMaybeJson: parseMaybeJson, qsParam: qsParam, debounce: debounce,
    stageLabel: stageLabel, stageBadge: stageBadge, chatTypeBadge: chatTypeBadge,
    syncBadge: syncBadge, roleBadge: roleBadge,
    initAuth: initAuth,
    TEAM_ROLES: TEAM_ROLES,
    STAGE_OPTIONS: STAGE_OPTIONS,
    loadingHtml: loadingHtml, emptyHtml: emptyHtml, errorHtml: errorHtml
  };

})(window);
