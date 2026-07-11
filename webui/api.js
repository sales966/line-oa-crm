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

  /**
   * 批次建檔:一次把多個 chatId 排入建檔(各自 upsert 為 pending)。
   * POST /api/customers/batch-full-sync {chatIds:[...]} → {ok:true, queued:N}
   * chatIds 會去重、濾空;空陣列直接回傳不打後端。
   */
  function batchFullSync(chatIds) {
    const ids = Array.isArray(chatIds)
      ? Array.from(new Set(chatIds.map(function (x) { return String(x || '').trim(); }).filter(Boolean)))
      : [];
    if (ids.length === 0) return Promise.resolve({ ok: true, queued: 0 });
    return post('/api/customers/batch-full-sync', { chatIds: ids });
  }

  // ---------- 大貨死線倒數徽章(客戶列表每列用) ----------
  // 以「當天 00:00」為基準算整數天數差(與後端 progressService.buildDeadline 一致):
  // <0 逾期、0 今天到期(紅)、1..7 臨近(黃)、>7 充裕(綠)。無死線回空字串。
  function deadlineBadge(at, daysLeft) {
    const t = Number(at);
    if (!at || !isFinite(t)) return '';
    var d = daysLeft;
    if (d === undefined || d === null || !isFinite(Number(d))) {
      const start = new Date(t); start.setHours(0, 0, 0, 0);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      d = Math.round((start.getTime() - today.getTime()) / 86400000);
    } else {
      d = Number(d);
    }
    var cls, text;
    if (d < 0) { cls = 'dl-overdue'; text = '逾期 ' + Math.abs(d) + ' 天'; }
    else if (d === 0) { cls = 'dl-overdue'; text = '今天到期'; }
    else if (d <= 7) { cls = 'dl-soon'; text = '剩 ' + d + ' 天'; }
    else { cls = 'dl-ok'; text = '剩 ' + d + ' 天'; }
    return '<span class="badge dl ' + cls + '" title="大貨死線 ' + esc(fmtDate(t)) + '">' + esc(text) + '</span>';
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
      (u && u.role === '管理' ? '<a class="user-menu-item" href="admin.html">🩺 系統健康</a>' : '') +
      (u && u.role === '管理' ? '<a class="user-menu-item" href="deploy.html">☁️ 阿里雲部署</a>' : '') +
      '<a class="user-menu-item" href="help.html">📖 使用說明</a>' +
      '<a class="user-menu-item" href="' + esc(issuesHref) + '">🐞 問題回報</a>' +
      '<button type="button" class="user-menu-item" data-act="qr">📱 手機版 QR</button>' +
      '<button type="button" class="user-menu-item" data-act="password">修改密碼</button>' +
      '<button type="button" class="user-menu-item danger" data-act="logout">登出</button>';
    menu.querySelector('[data-act="qr"]').addEventListener('click', function () {
      hideUserMenu();
      showQrModal();
    });
    menu.querySelector('[data-act="password"]').addEventListener('click', function () {
      hideUserMenu();
      showPasswordModal();
    });
    menu.querySelector('[data-act="logout"]').addEventListener('click', function () {
      hideUserMenu();
      logout();
    });
  }

  /** 手機版 QR 浮層:顯示當前後台網址的大 QR,方便跟單用手機掃碼進來 */
  function showQrModal() {
    if (document.getElementById('qr-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'qr-overlay';
    overlay.className = 'modal-overlay';
    const card = document.createElement('div');
    card.className = 'modal-card';
    // 掃碼後直接落在後台首頁(location.origin);QR 由後端 /api/qr 產生 SVG(免登入端點)
    const target = location.origin;
    const qrSrc = '/api/qr?size=480&data=' + encodeURIComponent(target);
    card.innerHTML =
      '<h2>📱 手機版 QR</h2>' +
      '<p style="margin:2px 0 12px;font-size:13px;color:var(--text-soft);">用手機相機掃描,即可在手機上開啟後台。請確認手機與後端在同一內網。</p>' +
      '<div style="text-align:center;">' +
      '<img src="' + esc(qrSrc) + '" alt="後台網址 QR" style="width:100%;max-width:260px;height:auto;border:1px solid var(--border);border-radius:10px;background:#fff;padding:8px;box-sizing:border-box;">' +
      '<div style="margin-top:10px;font-size:12px;color:var(--text-soft);word-break:break-all;">' + esc(target) + '</div>' +
      '</div>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn primary" id="qr-close">關閉</button>' +
      '</div>';
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    function close() { overlay.remove(); }
    card.querySelector('#qr-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
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

  // ---------- 全域離線偵測橫幅(所有頁共用;initAuth 時掛載) ----------
  // window 'offline'/'online' → 顯示/隱藏頂部橫幅;掛載時先依 navigator.onLine 初始化狀態。
  // 輕量:單一 fixed 元素,樣式內聯(不動 app.css),冪等(重覆呼叫僅同步狀態)。

  /** 顯示/隱藏離線橫幅(元素不存在時安全略過) */
  function setOfflineBanner(show) {
    const bar = document.getElementById('offline-banner');
    if (!bar) return;
    bar.hidden = !show;
  }

  /** 建立離線橫幅並掛 offline/online 監聽(冪等);已存在時僅重新同步當前狀態 */
  function mountOfflineBanner() {
    if (document.getElementById('offline-banner')) {
      setOfflineBanner(!navigator.onLine);
      return;
    }
    const bar = document.createElement('div');
    bar.id = 'offline-banner';
    bar.setAttribute('role', 'alert');
    bar.setAttribute('aria-live', 'assertive');
    bar.textContent = '⚠️ 網路中斷,操作暫停';
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
      'background:#dc2626', 'color:#fff', 'text-align:center',
      'font-size:14px', 'font-weight:600', 'letter-spacing:.5px',
      'padding:8px 12px', 'box-shadow:0 1px 4px rgba(0,0,0,.25)'
    ].join(';');
    bar.hidden = true;
    (document.body || document.documentElement).appendChild(bar);
    window.addEventListener('offline', function () { setOfflineBanner(true); });
    window.addEventListener('online', function () { setOfflineBanner(false); });
    setOfflineBanner(!navigator.onLine); // 掛載當下若已離線,立即顯示
  }

  /**
   * 頁面啟動時呼叫:掛全域離線橫幅 + GET /api/auth/me 確認登入並掛右上角使用者 chip。
   * 回傳 user;未登入(401)回 null 且 request() 已轉跳 login.html;
   * 後端無法連線等其他錯誤也回 null(不轉跳,由頁面自行顯示錯誤)。
   */
  async function initAuth() {
    mountOfflineBanner(); // 先掛橫幅:即使後端連不上(離線)也能提示使用者
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

  /**
   * 串流版產生/重生總結(SSE)。POST /api/summarize/:chatId/stream?force=1&orderId=N,
   * 讀 response.body 的 ReadableStream 解析 SSE 事件:
   *   event: delta → data 為 {"text":"…"} 或純文字 → onDelta(text)(即時預覽)。
   *                  注意:text 是「累積快照」(從頭到目前的完整 summaryText),非增量片段;
   *                  呼叫端須以覆蓋方式渲染(el.textContent = text),不可累加。
   *   event: done  → data 為 {"summary":{…}} 或 summary 物件 → resolve(summary) 並 onDone(summary)
   *   event: error → data 為 {"error":"…"} 或純文字 → reject(Error) 並 onError(msg)
   *
   * 這只是「多一條可選傳輸通道」:任何失敗(舊瀏覽器無 ReadableStream、網路斷、
   * 非 2xx、SSE 解析錯、未收到 done)一律 throw,呼叫端據此退回既有非串流 summarizeFor。
   * 401 沿用既有導頁邏輯。回傳 Promise<summary>。
   */
  async function summarizeStream(chatId, opts) {
    opts = opts || {};
    const force = !!opts.force;
    const orderId = Number(opts.orderId) || 0;
    const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : null;
    const onDone = typeof opts.onDone === 'function' ? opts.onDone : null;
    const onError = typeof opts.onError === 'function' ? opts.onError : null;

    // 舊瀏覽器不支援 fetch 串流 → 直接讓呼叫端退回非串流 POST
    if (typeof fetch !== 'function' || typeof ReadableStream === 'undefined' ||
        typeof TextDecoder === 'undefined') {
      throw new Error('瀏覽器不支援串流');
    }

    const url = '/api/summarize/' + encodeURIComponent(chatId) + '/stream' +
      orderQS(orderId, force ? { force: '1' } : null);

    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Accept': 'text/event-stream' } });
    } catch (e) {
      const err = new Error('無法連線到後端服務'); err.status = 0; err.cause = e;
      throw err;
    }

    // 非 2xx:401 沿用既有導頁;其餘一律拋出讓呼叫端退回非串流
    if (!res.ok) {
      if (res.status === 401 && !opts.noAuthRedirect) gotoLogin();
      let data = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.indexOf('application/json') !== -1) { try { data = await res.json(); } catch (e) { /* 容錯 */ } }
      const err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
      err.status = res.status; err.data = data;
      throw err;
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error('串流不可用'); // 讓呼叫端退回非串流
    }

    // data 可能是 JSON({text}/{summary}/{error})或純文字,寬鬆解析
    function jsonOrNull(str) {
      const s = String(str == null ? '' : str).trim();
      if (!s) return null;
      try { return JSON.parse(s); } catch (e) { return null; }
    }

    let summary = null;
    let doneReceived = false;
    let streamError = null;

    function handleEvent(rawEvent) {
      let eventName = 'message';
      const dataLines = [];
      rawEvent.split('\n').forEach(function (rawLine) {
        let line = rawLine;
        if (line.charCodeAt(0) === 0xFEFF) line = line.slice(1); // 去 BOM
        if (line === '' || line.charAt(0) === ':') return;        // 空行 / 註解(含心跳)
        const idx = line.indexOf(':');
        let field, value;
        if (idx === -1) { field = line; value = ''; }
        else {
          field = line.slice(0, idx);
          value = line.slice(idx + 1);
          if (value.charAt(0) === ' ') value = value.slice(1); // SSE 規範:冒號後首個空格略過
        }
        if (field === 'event') eventName = value.trim();
        else if (field === 'data') dataLines.push(value);
      });
      if (dataLines.length === 0) return;
      const dataStr = dataLines.join('\n');
      const parsed = jsonOrNull(dataStr);
      if (eventName === 'delta') {
        let text = dataStr;
        if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') text = parsed.text;
        else if (typeof parsed === 'string') text = parsed;
        if (text && onDelta) onDelta(text);
      } else if (eventName === 'done') {
        summary = (parsed && (parsed.summary || parsed)) || null;
        doneReceived = true;
      } else if (eventName === 'error') {
        streamError = (parsed && (parsed.error || parsed.message)) || dataStr || '串流錯誤';
      }
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n'); // 正規化換行,事件以空行分隔
        let sep;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const rawEvent = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          if (rawEvent.trim() !== '') handleEvent(rawEvent);
        }
        if (streamError) break; // 後端主動報錯 → 停止讀取
      }
      buf += decoder.decode();
      if (!streamError && buf.trim() !== '') handleEvent(buf); // flush 尾端未以空行結束的事件
    } catch (e) {
      try { reader.cancel(); } catch (_) { /* 忽略 */ }
      const err = new Error('串流中斷:' + (e && e.message ? e.message : String(e)));
      err.cause = e;
      throw err;
    }

    if (streamError) {
      if (onError) onError(streamError);
      throw new Error(streamError);
    }
    if (!doneReceived || !summary) {
      throw new Error('串流未完成'); // 未收到 done/summary → 退回非串流
    }
    if (onDone) onDone(summary);
    return summary;
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

  // ---------- 系統健康 + AI 用量(僅管理;admin.html 用) ----------

  /**
   * GET /api/admin/health → 系統健康快照。
   * 形狀由後端定,前端防禦性讀取常見欄位:
   * {llm, db:{sizeBytes,tables:[{name,count}]}, lastSyncAt, pendingBuild,
   *  backup:{enabled,lastBackupAt}, recentErrors:[{...}]}
   */
  function getAdminHealth() {
    return get('/api/admin/health');
  }
  /** GET /api/usage/summary → 近 30 天 AI 用量彙總 {days:[{date,count}], avgDurationMs, successRate, total} */
  function getUsageSummary() {
    return get('/api/usage/summary');
  }
  /** GET /api/usage/recent?limit= → {items:[{id,lineChatId,orderId,model,durationMs,ok,error,trigger,createdAt}]} */
  function getUsageRecent(limit) {
    return get('/api/usage/recent' + (limit ? ('?limit=' + encodeURIComponent(limit)) : ''));
  }

  // ---------- 備份管理(僅管理;admin.html 用) ----------
  // 後端契約(由 backend backup 路由提供;備份檔寫到 backend/backups/,已 gitignore):
  //   GET  /api/backup/list            → {backups:[{name,size,createdAt}]}(倒序;name = 檔名)
  //   POST /api/backup/run             → {ok:true, backup:{name,size,createdAt}}(立即備份一份)
  //   GET  /api/backup/download/:name  → 直接下載該備份檔(Content-Disposition: attachment;走同源 cookie)

  /** 備份清單 → {backups:[{name,size,createdAt}]}(前端防禦性讀取多種欄位命名) */
  function listBackups() { return get('/api/backup/list'); }
  /** 立即備份一份 → {ok, backup} */
  function runBackup() { return post('/api/backup/run'); }
  /** 某備份檔的下載網址(前端以 <a href>/window.open 直接下載;同源自帶 session cookie) */
  function backupDownloadUrl(name) {
    return '/api/backup/download/' + encodeURIComponent(name);
  }

  // ---------- 審計日志(全站;僅管理;admin.html 用) ----------
  // GET /api/audit?user=&action=&limit= → {logs:[{id,lineChatId,userId,userName,action,target,detail,createdAt}]} 倒序
  // 篩選參數後端可忽略(前端另做客端下拉篩選,零依賴後端是否支援 query)。
  /** 全站審計日志;params 可含 {user, action, limit} */
  function listAudit(params) {
    const p = new URLSearchParams();
    if (params) {
      if (params.user) p.set('user', String(params.user));
      if (params.action) p.set('action', String(params.action));
      if (params.limit) p.set('limit', String(params.limit));
    }
    const qs = p.toString();
    return get('/api/audit' + (qs ? ('?' + qs) : ''));
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

  // ---------- 客戶標籤(共享定義 + 客戶多對多)/ 全站搜尋 / 匯出 ----------
  // 後端契約(由 backend 標籤/搜尋/匯出路由提供;schema:tags / customer_tags):
  //   GET    /api/tags                         → {tags:[{id,name,color,createdAt}]}
  //   POST   /api/tags {name,color}            → {ok:true, tag:{id,name,color,createdAt}}
  //   PUT    /api/tags/:id {name?,color?}      → {ok:true, tag}(改名/改色;僅管理)
  //   DELETE /api/tags/:id                     → {ok:true}(連帶清 customer_tags;僅管理)
  //   GET    /api/customers/:chatId/tags       → {tags:[{id,name,color}]}
  //   PUT    /api/customers/:chatId/tags {tagIds:[...]} → {ok:true, tags:[...]}(整批覆蓋)
  //   GET    /api/customers?...&tagId=N        → 依標籤篩選(併入既有客戶列表)
  //   GET    /api/search?q=                    → {results:[{lineChatId,customerName,matchType,snippet}]}
  //   GET    /api/export/customers.csv?...      → CSV 下載(Content-Disposition: attachment)

  /** 所有標籤定義 → {tags:[{id,name,color,createdAt}]} */
  function listTags() { return get('/api/tags'); }
  /** 新增標籤定義 → {ok,tag} */
  function createTag(name, color) { return post('/api/tags', { name: name, color: color }); }
  /** 改標籤定義(名稱/顏色;只送要改的欄位) → {ok,tag} */
  function updateTag(id, patch) { return put('/api/tags/' + encodeURIComponent(id), patch); }
  /** 刪標籤定義(連帶清所有客戶的此標籤) → {ok} */
  function deleteTag(id) { return del('/api/tags/' + encodeURIComponent(id)); }
  /** 某客戶目前的標籤 → {tags:[{id,name,color}]} */
  function getCustomerTags(chatId) {
    return get('/api/customers/' + encodeURIComponent(chatId) + '/tags');
  }
  /** 整批覆蓋某客戶的標籤(去重、濾非正整數) → {ok,tags} */
  function setCustomerTags(chatId, tagIds) {
    const ids = Array.isArray(tagIds)
      ? Array.from(new Set(tagIds.map(Number).filter(function (n) { return Number.isFinite(n) && n > 0; })))
      : [];
    return put('/api/customers/' + encodeURIComponent(chatId) + '/tags', { tagIds: ids });
  }

  /**
   * 客戶列表(看板 / 列表共用)。params 可為 URLSearchParams、查詢字串或物件;
   * 省略則取全部。回傳 {customers:[{lineChatId,lineName,currentStage,followedUp,
   * msgCount,fileCount,deadlineAt,syncStatus,tags:[{id,name,color}],lastMessageAt,...}]}。
   */
  function getCustomers(params) {
    let qs = '';
    if (params instanceof URLSearchParams) qs = params.toString();
    else if (typeof params === 'string') qs = params.replace(/^\?/, '');
    else if (params && typeof params === 'object') qs = new URLSearchParams(params).toString();
    return get('/api/customers' + (qs ? ('?' + qs) : ''));
  }

  /**
   * 設定 / 清除人工釘選階段(看板拖曳用)。
   * stage 傳階段名(如 '已打樣')= 人工釘選並覆蓋 AI 判定;傳 null/'' = 清除釘選回自動判定。
   * 走既有 PUT /api/customers/:chatId/progress/meta {stageOverride}。
   */
  function setStageOverride(chatId, stage) {
    const s = (stage === null || stage === undefined || stage === '') ? null : String(stage);
    return putMeta(chatId, { stageOverride: s });
  }

  /** 全站搜尋(客戶名/總結/訊息/檔案/備註…) → {results:[{lineChatId,customerName,matchType,snippet}]} */
  function search(q) {
    return get('/api/search?q=' + encodeURIComponent(q || ''));
  }

  /** 匯出客戶清單 CSV 的端點(前端以 <a> 直接下載;可帶與客戶列表相同的篩選查詢字串) */
  const EXPORT_CUSTOMERS_CSV = '/api/export/customers.csv';

  // ---------- 格式化工具 ----------

  /** HTML escape,所有伺服器文字必經此函式 */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 顏色淨化:只接受 #rgb / #rrggbb,否則回預設灰(防 style 注入 + 容錯) */
  function sanitizeColor(c) {
    const s = String(c || '').trim();
    return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(s) ? s : '#6b7280';
  }

  /** 依背景色亮度算可讀文字色(淺底→深字,深底→白字) */
  function readableTextColor(bg) {
    const hex = sanitizeColor(bg).replace(/^#/, '');
    let r, g, b;
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16); g = parseInt(hex[1] + hex[1], 16); b = parseInt(hex[2] + hex[2], 16);
    } else {
      r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
    }
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? '#1f2937' : '#ffffff';
  }

  /** 標籤徽章 HTML(彩色小徽章;顏色淨化 + 名稱 escape) */
  function tagChipHtml(tag) {
    if (!tag || !tag.name) return '';
    const bg = sanitizeColor(tag.color);
    const fg = readableTextColor(bg);
    return '<span class="tag-chip" style="background:' + bg + ';color:' + fg + ';">' + esc(tag.name) + '</span>';
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
    getFullSync: getFullSync, requestFullSync: requestFullSync, batchFullSync: batchFullSync,
    getDashboardStats: getDashboardStats, getDashboardReminders: getDashboardReminders,
    getTeamMessages: getTeamMessages, postTeamMessage: postTeamMessage,
    login: login, logout: logout, fetchMe: fetchMe, getUser: getUser,
    changePassword: changePassword,
    getProgress: getProgress, putTask: putTask, putMeta: putMeta,
    getOrders: getOrders, createOrder: createOrder, updateOrder: updateOrder, deleteOrder: deleteOrder,
    getProgressFor: getProgressFor, putTaskFor: putTaskFor, putMetaFor: putMetaFor,
    getSummariesFor: getSummariesFor, getMessagesFor: getMessagesFor, summarizeFor: summarizeFor,
    summarizeStream: summarizeStream,
    uploadFile: uploadFile,
    suggestMentions: suggestMentions, getMyMentions: getMyMentions, readMentions: readMentions,
    editSummary: editSummary, getAnnotations: getAnnotations, addAnnotation: addAnnotation,
    getAudit: getAudit,
    getAdminHealth: getAdminHealth, getUsageSummary: getUsageSummary, getUsageRecent: getUsageRecent,
    listBackups: listBackups, runBackup: runBackup, backupDownloadUrl: backupDownloadUrl,
    listAudit: listAudit,
    listTags: listTags, createTag: createTag, updateTag: updateTag, deleteTag: deleteTag,
    getCustomerTags: getCustomerTags, setCustomerTags: setCustomerTags,
    getCustomers: getCustomers, setStageOverride: setStageOverride,
    search: search, EXPORT_CUSTOMERS_CSV: EXPORT_CUSTOMERS_CSV
  };
  global.UI = {
    esc: esc, relTime: relTime, fmtDate: fmtDate, fmtDateTime: fmtDateTime, pad2: pad2,
    fmtSize: fmtSize, parseMaybeJson: parseMaybeJson, qsParam: qsParam, debounce: debounce,
    stageLabel: stageLabel, stageBadge: stageBadge, chatTypeBadge: chatTypeBadge,
    syncBadge: syncBadge, roleBadge: roleBadge, deadlineBadge: deadlineBadge,
    sanitizeColor: sanitizeColor, readableTextColor: readableTextColor, tagChipHtml: tagChipHtml,
    initAuth: initAuth,
    TEAM_ROLES: TEAM_ROLES,
    STAGE_OPTIONS: STAGE_OPTIONS,
    loadingHtml: loadingHtml, emptyHtml: emptyHtml, errorHtml: errorHtml
  };

})(window);
