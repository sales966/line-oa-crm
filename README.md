# LINE OA 客戶進度中樞

> 把 LINE 官方帳號的客戶對話、檔案，自動歸檔並用 LLM 產生總結、判定進度階段，讓業務團隊在區域網路後台共同追蹤每一筆生意。

專為**包裝／訂製製造業**設計：客服在 LINE 與客戶洽談 → 系統採集對話與檔案 → AI 產出條列式總結、判定「洽談 → 已回簽 → 已打樣 → 已出廠 → 已交付」五階段進度、抓出承諾交期，跟單與設計在後台一眼掌握狀態。

---

## ✨ 核心功能

| 功能 | 說明 |
|---|---|
| 🔄 **LINE 對話採集** | Chrome 擴充功能以已登入的 session 讀取 `chat.line.biz` 的對話、記事本、檔案，推送到本地後端。白名單模式，只同步挑選的客戶。 |
| 🗂 **檔案永久歸檔** | 客戶上傳的設計稿 / 照片 / PDF 下載存本地，不受 LINE 檔案過期影響。可即時預覽、依類型（圖片 / PDF / 設計檔）分類。 |
| 🧠 **AI 條列式總結** | 用 LLM（OpenAI / 可切換）產出客戶洽談重點：背景、需求規格、數量報價、目前進度、待辦。可人工編輯、加批註。 |
| 📊 **五階段進度紅綠燈** | LLM 依對話證據自動判定各階段任務完成與否（🟢/🔴），每個綠燈附上「聊天裡哪句話證明達成」的證據；可人工點燈、補證據。 |
| ⏰ **大貨死線倒數** | LLM 自動抓出承諾客戶的交期，或人工設定；置於進度面板最上方醒目倒數，逾期紅字警示。 |
| 💬 **內部討論（AI 有記憶）** | 團隊在客戶頁留言討論（客戶看不到），討論內容會被納入 AI 總結的背景記憶。支援 @人、@檔案、拖曳檔案分享。 |
| 🔔 **提及通知** | @到你時鈴鐺提示。 |
| 👥 **帳號權限** | 登入制，角色分跟單 / 設計 / 客服 / 管理；管理員可建立帳號。 |
| 📜 **變更紀錄** | 所有進度 / 總結 / 檔案的異動都留審計軌跡。 |
| 🐞 **問題回報 / 📖 使用說明** | 內建同仁問題回報與圖文使用說明。 |
| 🏷 **客戶標籤** | 為客戶打標籤、依標籤快速篩選；管理員維護標籤定義。 |
| 🔎 **全站搜尋** | 跨客戶名稱、對話內容、AI 總結一次搜尋。 |
| 🗃 **看板視圖** | 六欄階段看板，可拖曳人工釘選階段，亦可一鍵還原為自動判定。 |
| ⚡ **總結串流顯示** | 以 SSE 邊生成邊出字，串流失敗自動退回一般模式。 |
| 📤 **匯出 CSV** | 一鍵匯出全客戶清單，UTF-8 BOM 相容 Excel 中文。 |
| 🖨 **單客戶列印 / PDF** | 單一客戶頁一鍵列印或輸出 PDF。 |
| ✅ **待辦提醒增強** | 新增「待建檔」「尚未生成總結」等待辦提示。 |
| 💾 **自動備份排程** | better-sqlite3 線上備份，每 6 小時一次、保留 30 份；亦可手動備份 / 下載。 |
| 🛡 **審計日誌檢視** | 管理員可檢視全站審計日誌並依條件篩選。 |
| 🧪 **自動化測試** | node:test 共 74 項；一律使用臨時資料庫，絕不觸碰正式資料。 |

---

## 🏗 架構

```
┌──────────────── 單機部署（24×7 Windows / 區域網路）────────────────┐
│                                                                    │
│  ① Chrome 擴充功能 (extension-sync/)  ── MV3，純 JS                 │
│     · 在 chat.line.biz 以登入 session 呼叫 LINE 內部 API            │
│     · 白名單客戶：抓對話 + 下載檔案 → 推送後端                       │
│     · 每小時（10–22 時）定時 + 新訊息即時偵測 + 手動                 │
│                     │ HTTP（X-Extension-Token）                     │
│  ② 後端 (backend/)  ── Node + TypeScript + Fastify + SQLite         │
│     · 採集入庫、檔案落地、LLM 總結、進度引擎、審計                   │
│     · session 認證、角色權限                                        │
│                     │ 同源服務                                      │
│  ③ 後台 Web (webui/)  ── 純靜態 HTML/CSS/JS，繁體中文               │
│     · 客戶列表 / 詳情：對話時間軸、AI 總結、進度、檔案庫、內部討論   │
└────────────────────────────────────────────────────────────────────┘
```

**技術棧**：全 TypeScript / JavaScript。後端 Fastify + better-sqlite3（單一 `.db` 檔，零外部服務）；前端零建置純靜態；擴充功能 Manifest V3 純 JS。LLM 走 provider 抽象，預設 OpenAI，可切換。

---

## 📁 專案結構

```
lineoa/
├─ backend/               # Node + TypeScript 後端
│  ├─ src/
│  │  ├─ server.ts        # Fastify 入口（port 4680）
│  │  ├─ db.ts            # SQLite 初始化 + migrations
│  │  ├─ authHook.ts      # session / 擴充 Token 認證
│  │  ├─ routes/          # ingest / read / files / summarize / progress / auth / users / mentions / issues …
│  │  ├─ services/        # 業務邏輯（chat / file / summary / progress / audit / auth …）
│  │  └─ llm/             # provider 抽象（openai / claude）
│  ├─ package.json
│  └─ .env.example
├─ webui/                 # 純靜態後台（index / customer / login / users / issues / help）
├─ extension-sync/        # Chrome MV3 採集擴充
└─ start.bat              # 一鍵啟動後端
```

---

## 🚀 安裝與啟動

### 需求
- Windows（或任何能跑 Node 的機器）
- Node.js 20+（建議 22）
- Chrome 瀏覽器
- 一支 LINE 官方帳號（客服用）
- LLM 金鑰（OpenAI，可選；未設定則總結功能停用，其餘照常）

### 1. 後端

```bash
cd backend
npm install
cp .env.example .env        # 然後編輯 .env 填入設定（見下）
npm run start               # 或回專案根目錄雙擊 start.bat
```

`.env` 設定：

```ini
OPENAI_API_KEY=sk-...            # LLM 金鑰（留空則停用 AI 總結）
LLM_MODEL=gpt-5.5               # 使用的模型
PORT=4680
EXTENSION_TOKEN=<自訂一串隨機碼>  # 擴充功能與後端的通行金鑰
ADMIN_INITIAL_PASSWORD=changeme  # admin 初始密碼（首次啟動建立，登入後請修改）
```

啟動後開 `http://localhost:4680`，以 `admin` 登入。

### 2. Chrome 擴充功能

1. `chrome://extensions` → 開啟「開發人員模式」
2. 「載入未封裝項目」→ 選 `extension-sync/` 資料夾
3. 點擊擴充圖示 →「開啟設定」→ 填入**後端網址**（`http://localhost:4680` 或伺服器區網 IP）與 **API Token**（`.env` 的 `EXTENSION_TOKEN`）→ 儲存

> 登入頁下方會顯示後端網址與 Token，方便同仁複製設定。

### 3. 開始使用

1. 在 Chrome 登入 `chat.line.biz`，保持分頁開啟
2. 打開某客戶聊天室 → 擴充功能「➕ 加入同步」
3. 回後台 → 客戶出現 → 點「🔄 建檔」拉完整歷史 + 檔案 → AI 自動總結
4. 團隊即可在客戶頁看總結、進度、檔案、內部討論

---

## 🔐 安全與隱私

- **所有資料只存在部署的那台機器**：對話、檔案、帳號都在本地 SQLite 與檔案夾，不外傳第三方。
- `.env`（金鑰）、`data/`（資料庫）、`storage/`（客戶檔案）皆已 `.gitignore`，**不會進入版本庫**。
- 後端建議只在**區域網路**開放（不要對外網做 4680 的埠轉發）。
- LLM 總結會將對話文字送往你設定的 LLM 服務商處理；若在意可自行遮罩敏感欄位或改用本地模型。

> ⚠️ 本公開庫僅含**程式碼**，不含任何真實客戶資料、金鑰或內部設計文件。

---

## 🧩 LLM Provider

`backend/src/llm/` 以介面抽象，預設 OpenAI（`provider-openai.ts`），並預留 Claude（`provider-claude.ts`）。要換供應商只需實作同介面並在 `index.ts` 切換，其餘不動。

---

## 📄 授權

本專案為內部工具開源分享，請依需求自行調整。歡迎 fork。

---

*Built for 清晨沙灘 / MORNINGBEACH.TW 的包裝業務團隊。*
